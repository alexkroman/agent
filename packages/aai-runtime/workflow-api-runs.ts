// Copyright 2026 the AAI authors. MIT license.
/**
 * The five RUN routes' handlers: start, read, cancel, wake, list.
 *
 * Split from `workflow-api.ts` when the uploads pair arrived and that module
 * went past its length cap. The seam is the one already in the surface: these
 * five are each one `WorkflowClient` call plus the HTTP shape around it, while
 * what stays behind is the router — the token gate, the engine resolution, the
 * route table and its ordering rules.
 *
 * `workflow-api.ts`'s module doc is still the authoritative table of the whole
 * surface; nothing here is a second one.
 */

import type http from "node:http";
import { requestQuery } from "@alexkroman1/aai/host-internal";
import { clampWorkflowWait } from "@alexkroman1/aai/internal";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { isTerminal } from "@alexkroman1/aai/workflow-api";
import { isWorkflowRequestError } from "./_workflow-request-error.ts";
import type { Logger } from "./runtime-config.ts";
import { MAX_WORKFLOW_INPUT_BYTES, numberParam, readBody, sendJson } from "./workflow-api-http.ts";
import { waitForRun } from "./workflow-api-wait.ts";
import { MAX_WORKFLOW_FIND_LIMIT } from "./workflow-keys.ts";
import { readRunOnce } from "./workflow-run-reads.ts";
import type { UploadStore } from "./workflow-uploads.ts";

/**
 * What this API is served from: `ctx.workflows`, unchanged.
 *
 * An alias rather than a structural restatement, and the aliasing is the point.
 * The predecessor design had the API take a wider "engine" that added run-store
 * reads of its own, and the width was what let route code drift into the
 * journal. Naming the client makes the constraint checkable by the compiler: a
 * route can only do what a tool can do.
 *
 * @internal
 */
export type WorkflowApiEngine = import("@alexkroman1/aai").WorkflowClient;

/**
 * What every route is handed: the client, the upload store beside it, and the
 * log both write to.
 *
 * A record rather than three parameters because only one route pair reads the
 * store, and threading an unused argument through six handlers is how a
 * signature stops describing anything.
 *
 * @internal
 */
export type RouteContext = {
  engine: WorkflowApiEngine;
  /** Undefined on a server that was given no store — the routes then 404. */
  uploads: UploadStore | undefined;
  /**
   * Whether a part's bytes go somewhere OTHER than this server — see
   * `WorkflowApiOptions.directParts`, which is where the argument lives.
   */
  directParts?: boolean | undefined;
  logger: Logger;
};

/**
 * The ONE query key `POST /workflows/runs/:id/wake` reads — see {@link wakeRun}.
 *
 * Singular and repeatable, and named here rather than written twice so the
 * refusal below and the read cannot name different keys.
 */
const WAKE_QUERY_KEY = "correlationId";

/**
 * The four fields `POST /workflows/runs` serves, and the whole of them.
 *
 * A CLOSED set, checked below, because the alternative was the worst of the
 * three available answers. The handler destructured these and dropped the rest,
 * so a body carrying `notify: true` — a real {@link
 * import("@alexkroman1/aai").StartOptions} field this route does not serve —
 * was answered `202` and did not notify, and `keys` for `key` indexed the run
 * under nothing and answered `202` to a caller who would never find it again.
 * Accept-and-drop is indistinguishable from success at every level a caller can
 * look at.
 *
 * The cost is stated rather than hidden: a client sending a field a NEWER server
 * understands is refused by an older one, where before it degraded to a working
 * request minus the extra. Taken because every caller in the tree goes through
 * `createWorkflowApiClient`, which sends exactly these four — so the refusal has
 * no reachable false positive, and a new field ships with the client that sends
 * it.
 */
const START_RUN_FIELDS = ["workflow", "input", "key", "wait"] as const;

/**
 * Longest correlation key this API accepts.
 *
 * `key` was bounded only by {@link MAX_WORKFLOW_INPUT_BYTES}, so a 64 kB key was
 * accepted, written into `aai_workflow_run_keys` and INDEXED there, on a surface
 * that is open unless the operator sets `AAI_WORKFLOW_API_TOKEN`. What a key
 * really is is a session id, a phone number, an account id or an upload id — see
 * `StartOptions.key` — so 256 admits every honest one with room to spare, and
 * `GET /runs?key=` is bounded by the same number so the write and the lookup
 * cannot disagree about what is representable.
 *
 * @internal
 */
export const MAX_WORKFLOW_KEY_LENGTH = 256;

/** `POST /workflows/runs` — start a run and answer 202 with its id. */
export async function startRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const { engine } = ctx;
  const body = await readBody(req, MAX_WORKFLOW_INPUT_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "Body must be JSON" });
    return;
  }
  // A record BEFORE anything talks about its keys — `JSON.parse("[1,2]")` and
  // `JSON.parse("7")` both succeed and destructure to all-undefined, which used
  // to be reported as a body naming no workflow.
  if (!isRecord(parsed)) {
    sendJson(res, 400, { error: 'Body must be a JSON object: { "workflow": "<name>", input? }' });
    return;
  }
  const unknownKeys = Object.keys(parsed).filter(
    (k) => !(START_RUN_FIELDS as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    // NAMED, because the whole failure this replaces is a caller unable to see
    // which of its fields went nowhere. The names are the caller's own strings,
    // so they are capped the way `key` is below rather than echoed at length.
    sendJson(res, 400, {
      error: `Unknown field(s) in body: ${unknownKeys
        .slice(0, 5)
        .map((k) => JSON.stringify(k.slice(0, MAX_WORKFLOW_KEY_LENGTH)))
        .join(", ")}. This route takes ${START_RUN_FIELDS.join(", ")}.`,
    });
    return;
  }
  const { workflow, input, key, wait } = parsed as {
    workflow?: unknown;
    input?: unknown;
    key?: unknown;
    wait?: unknown;
  };
  if (typeof workflow !== "string") {
    sendJson(res, 400, { error: 'Body must name a workflow: { "workflow": "<name>", input? }' });
    return;
  }
  // Refused rather than coerced: a non-string key would be indexed as whatever
  // `String()` made of it and then never match the `find` a caller writes.
  if (key !== undefined && typeof key !== "string") {
    sendJson(res, 400, { error: '"key" must be a string when present' });
    return;
  }
  if (key !== undefined && key.length > MAX_WORKFLOW_KEY_LENGTH) {
    sendJson(res, 400, {
      error: `"key" must be at most ${MAX_WORKFLOW_KEY_LENGTH} characters`,
    });
    return;
  }
  // `start` rejects an unknown name and an input failing the workflow's own
  // schema, and both are the CALLER's mistake — so they are 400s carrying the
  // client's message (which names the declared workflows, or the schema issues)
  // rather than 500s. Everything else is ours, and is RETHROWN to the router,
  // whose `answerHandlerFailure` logs the cause and answers an opaque 500.
  //
  // The type test is what makes that split real — `isWorkflowRequestError`, and
  // not `instanceof`, because a guest runs two copies of this SDK and the copy
  // that throws is not the copy that catches (see `_workflow-request-error.ts`).
  // This used to catch everything
  // and answer 400 with `errorMessage(err)` under a comment claiming the router
  // had the rest — but the `try` covers the world call, so it never did: a
  // six-second Postgres outage answered a form submission
  // `400 {"error":"connect ECONNREFUSED 127.0.0.1:54399"}`, which tells a client
  // its request was bad (so nothing retries) and hands the database's host and
  // port to anyone with the page's URL, this surface being unauthenticated
  // unless the operator sets `AAI_WORKFLOW_API_TOKEN`.
  let runId: string;
  try {
    runId = await engine.start(workflow, input, key === undefined ? undefined : { key });
  } catch (err) {
    if (!isWorkflowRequestError(err)) throw err;
    sendJson(res, 400, { error: err.message });
    return;
  }
  // The run's opening line in the server log. A workflow app otherwise answers
  // this request and then does minutes of work with nothing anywhere naming it;
  // every later line a step writes through `report()` is read against this one.
  //
  // The caller's `key` is deliberately NOT on it, and used to be. A
  // caller-controlled string in an operator's log is a liability twice over: it
  // was length-unbounded until the check above, and what a key IS is routinely a
  // phone number (`StartOptions.key`'s own example), which puts caller PII into a
  // stream with different retention and different readers from the database that
  // legitimately holds it. Nothing is lost: `runId` is the identifier every later
  // line of this run carries, and `GET /runs?workflow=&key=` is what answers
  // "which run belongs to this key".
  ctx.logger.info("Workflow run started", { workflow, runId });
  // 202 and the id alone: the run is durable, and deliberately not finished —
  // that is the whole point of the mechanism (see `WorkflowClient.start`).
  if (typeof wait !== "number" || clampWorkflowWait(wait) === 0) {
    sendJson(res, 202, { runId });
    return;
  }
  // The synchronous mode. `run` rides ALONGSIDE `runId` rather than replacing
  // it, so a caller that reads `runId` behaves the same whether it asked to
  // wait or not — and a wait that runs out still hands back the one thing it
  // cannot reconstruct. See `workflow-api-wait.ts` for why an expired budget is
  // an answer rather than an error.
  const run = await waitForRun(engine, runId, wait, res);
  sendJson(res, isTerminal(run) ? 200 : 202, { runId, ...omitUndefined({ run }) });
}

/**
 * `GET /workflows/runs/:id` — read one run's state, optionally waiting it out.
 *
 * `?wait=<ms>` holds the request open until the run settles, which is how a
 * caller with an id resumes the synchronous mode after a `POST` that timed out.
 * The BODY is the same either way — a snapshot — so waiting is invisible to
 * anything that parses the answer.
 *
 * A wait with NO reading is a 400, and a wait `clampWorkflowWait` already
 * documents a reading for is left to it. This was `Number(query.get("wait"))`,
 * which reads a blank parameter as `0` and `abc` as `NaN` and clamps both to
 * "do not wait" — the same defect `?startIndex=` had, where it was harmful, so
 * it goes through the same `numberParam`. `0`, a negative and an infinity keep
 * meaning "do not wait" because that IS the clamp's published contract, shared
 * by both ends; refusing them here would be this route re-deriving it and would
 * fail `api.get(runId, { wait: -1 })` against a rule the SDK does not state.
 */
export async function readRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: WorkflowApiEngine,
  runId: string,
): Promise<void> {
  const waitParam = requestQuery(req.url).get("wait");
  const wait = waitParam === null ? 0 : numberParam(waitParam);
  if (Number.isNaN(wait)) {
    sendJson(res, 400, { error: "`wait` must be a number" });
    return;
  }
  // BOTH arms go through the shared reads — the wait loop always did, and the
  // no-wait arm is `readRunOnce` for the reason its own doc gives: an un-shared
  // read is a platform round trip of its own beside the ones this run's
  // watchers are already taking.
  const run = runId
    ? await (clampWorkflowWait(wait) > 0
        ? waitForRun(engine, runId, wait, res)
        : readRunOnce(engine, runId))
    : undefined;
  if (!run) {
    sendJson(res, 404, { error: `No workflow run with id ${runId}` });
    return;
  }
  sendJson(res, 200, run);
}

/** `DELETE /workflows/runs/:id` — stop a live run. */
export async function cancelRun(
  res: http.ServerResponse,
  ctx: RouteContext,
  runId: string,
): Promise<void> {
  if (!runId) {
    sendJson(res, 404, { error: "No workflow run named" });
    return;
  }
  ctx.logger.info("Workflow run cancelled", { runId });
  // 200 with `cancelled: false` rather than a 4xx for a run that had already
  // finished: two tabs pressing Stop is ordinary, and "it was already over" is
  // an ANSWER. The client surfaces the distinction; nothing needs an error to.
  //
  // This comment was here before the behaviour was. The engine translated only
  // the DevKit's "no such run" into `false`, so a run that COMPLETED between the
  // render and the click — the very race described above — reached the handler
  // as an `EntityConflictError` and left as `500 Internal server error`. The
  // translation lives with the adapter that has to know the DevKit's error
  // vocabulary: `isRunOver` in `workflow-wdk.ts`.
  sendJson(res, 200, { runId, cancelled: await ctx.engine.cancel(runId) });
}

/**
 * `POST /workflows/runs/:id/wake` — end a run's `sleep()` early.
 *
 * `woken` is how many pending sleeps were interrupted, so `0` is an honest
 * answer rather than an error: the run finished, was never sleeping, or is gone.
 * Same reasoning as `cancelled: false` on the DELETE above — two tabs pressing
 * "send it now" is ordinary, and the second one is not a failure.
 *
 * A POST rather than a DELETE-shaped verb because it does not remove anything;
 * it is a state change on a run that keeps running.
 *
 * ## `?correlationId=` is what makes a TARGETED wake reachable
 *
 * Repeatable, and it is the whole of `WakeUpOptions.correlationIds`. This
 * handler called `wakeUp(runId)` against a signature of `wakeUp(runId,
 * options?)`, so **the ids were discarded** and two things followed. A caller
 * asking to end one particular wait ended every `sleep` on the run. And because
 * a BARE wake deliberately cannot reach a `kind: "hookTimeout"` — the journal
 * filters it, and the filter exists because journaling a hook's deadline as an
 * ordinary sleep once let one `wakeUp()` close every approval window on a run —
 * a hook's approval deadline could not be cut short over HTTP AT ALL, there
 * being no reachable spelling of the request.
 *
 * Named ids DO reach a `hookTimeout`, and that is `wakeSleeps`' own rule rather
 * than a widening introduced here: it counts the waits declared with one of
 * those ids, whatever their kind. The exclusion is scoped to the bare call
 * because a bare call is the blunt "send it now" button, where closing an
 * approval window is a SIDE EFFECT; naming the id of the wait you mean is the
 * caller identifying exactly one wait, which is the narrow, explicit form the
 * exclusion was never about. So the blunt spelling still cannot reach a
 * deadline and the specific one can.
 *
 * A blank `?correlationId=` is REFUSED rather than read as "no id": the journal
 * is explicit that an empty-string id is not the same as an absent one (two
 * backends used to fold them together and woke every uncorrelated sleep on the
 * run), so a caller that meant to send an id and sent nothing must not be served
 * the blunt wake by accident. Same call `?limit=` and `?startIndex=` get.
 *
 * **And an unknown query key is refused for the same reason**, which is
 * {@link START_RUN_FIELDS}' argument one route over: accept-and-drop is
 * indistinguishable from success at every level a caller can look at, and here
 * what it degrades to is the BLUNT wake — every outstanding sleep on the run,
 * where the caller named one. The mistake is not hypothetical: the parameter is
 * singular and repeatable while the SDK field it fills is
 * `WakeUpOptions.correlationIds`, so `?correlationIds=review-window` is the
 * natural spelling, and it answered `200 {woken: 1}` having woken a wait whose
 * id was nothing like it — found by hand against a dev server. A wake is a
 * permanent, widening effect, so the refusal is worth the strictness here in a
 * way it is not on the `GET` reads beside it.
 */
export async function wakeRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
  runId: string,
): Promise<void> {
  if (!runId) {
    sendJson(res, 404, { error: "No workflow run named" });
    return;
  }
  const query = requestQuery(req.url);
  const unknown = [...new Set(query.keys())].filter((key) => key !== WAKE_QUERY_KEY);
  if (unknown.length > 0) {
    sendJson(res, 400, {
      error:
        `Unknown query parameter(s) ${unknown.join(", ")}. ` +
        `This route takes \`${WAKE_QUERY_KEY}\`, repeated once per wait; ` +
        "a wake with none named ends every outstanding sleep on the run.",
    });
    return;
  }
  const correlationIds = query.getAll(WAKE_QUERY_KEY);
  if (correlationIds.some((id) => id.trim() === "")) {
    sendJson(res, 400, { error: "`correlationId` must not be empty" });
    return;
  }
  if (correlationIds.some((id) => id.length > MAX_WORKFLOW_KEY_LENGTH)) {
    sendJson(res, 400, {
      error: `\`correlationId\` must be at most ${MAX_WORKFLOW_KEY_LENGTH} characters`,
    });
    return;
  }
  ctx.logger.info("Workflow run woken", { runId, correlationIds: correlationIds.length });
  const woken = await ctx.engine.wakeUp(
    runId,
    correlationIds.length > 0 ? { correlationIds } : undefined,
  );
  sendJson(res, 200, { runId, woken });
}

/**
 * The page size `GET /workflows/runs` will apply, or `undefined` having ALREADY
 * answered 400.
 *
 * Its own function because `findRuns` reads three parameters and this is two of
 * the three answers — past the cognitive-complexity ceiling inline, which is the
 * ceiling doing its job: the LIMIT decision is a self-contained argument and the
 * route around it is a client call plus an error split.
 *
 * Two messages rather than one, because `?limit=lots` and `?limit=2.5` are
 * different mistakes and the second one is a caller that thinks it is asking a
 * legal question.
 *
 * And two ANSWERS for two kinds of wrong, which is the whole of it. A limit with
 * no truthful reading — `-5`, `0`, `2.5`, an empty `?limit=` — is REFUSED. There
 * is no page size to clamp those to: this used to check `Number.isFinite` and
 * nothing else, so a negative reached the platform journal as `LIMIT -1` and came
 * back as a 503, i.e. "retry", for a request that can never succeed. A limit that
 * is merely too big is CLAMPED, because this is the boundary a human types a URL
 * into and a page asking for five hundred wants as many as it can have. What it
 * must not get is a hundred rows that look like all of them, so `truncatedTo`
 * says it was cut. (`resolveFindLimit` inside the client clamps too — that is the
 * backstop; the announcement is why it also happens here, where the caller's own
 * number is still in hand.)
 */
function findPageOr400(
  res: http.ServerResponse,
  limitParam: string | null,
): { options: { limit: number } | undefined; truncatedTo: number | undefined } | undefined {
  const limit = limitParam === null ? undefined : Number(limitParam);
  if (limit !== undefined && !Number.isFinite(limit)) {
    sendJson(res, 400, { error: "`limit` must be a number" });
    return undefined;
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    sendJson(res, 400, { error: "`limit` must be a positive integer" });
    return undefined;
  }
  if (limit === undefined) return { options: undefined, truncatedTo: undefined };
  const applied = Math.min(limit, MAX_WORKFLOW_FIND_LIMIT);
  return {
    options: { limit: applied },
    truncatedTo: limit > MAX_WORKFLOW_FIND_LIMIT ? applied : undefined,
  };
}

/**
 * `GET /workflows/runs?workflow=<name>&key=<key>&limit=<n>` — runs of one
 * workflow, newest first.
 *
 * The query is read off `req.url` rather than the `url` argument, which the
 * server has already stripped of its query string — every other route here is an
 * exact or prefix path match, so this is the only one that needs it.
 *
 * `limit` is bounded by `MAX_WORKFLOW_FIND_LIMIT`. When a caller asks for more
 * than that the answer carries `truncatedTo`, which is the page size actually
 * applied — see {@link findPageOr400} for why one kind of bad limit is clamped
 * and the other refused. A caller that names no limit gets the client's own
 * `DEFAULT_WORKFLOW_FIND_LIMIT` and no `truncatedTo`, there being nothing to
 * announce.
 */
export async function findRuns(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: WorkflowApiEngine,
): Promise<void> {
  const params = requestQuery(req.url);
  const workflow = params.get("workflow");
  const key = params.get("key");
  if (!workflow) {
    sendJson(res, 400, { error: "A `workflow` query parameter is required" });
    return;
  }
  // The same bound the WRITE takes, so what can be recorded and what can be
  // looked up cannot disagree — and so this read cannot be handed an unbounded
  // caller string to index against either.
  if (key !== null && key.length > MAX_WORKFLOW_KEY_LENGTH) {
    sendJson(res, 400, { error: `\`key\` must be at most ${MAX_WORKFLOW_KEY_LENGTH} characters` });
    return;
  }
  const page = findPageOr400(res, params.get("limit"));
  if (!page) return;
  const { options, truncatedTo } = page;
  try {
    // `key` present narrows to that correlation key; absent lists the workflow's
    // recent runs whatever key they carry — the operator's read (a console has
    // no key to ask about, and an unkeyed run has none to be found by). Two
    // client methods rather than one nullable argument, so a caller meaning
    // "this session" cannot silently widen to every session.
    const runs = key
      ? await engine.find(workflow, key, options)
      : await engine.recent(workflow, options);
    sendJson(res, 200, { runs, ...omitUndefined({ truncatedTo }) });
  } catch (err) {
    // An unknown workflow name is the caller's mistake, exactly as it is on
    // `POST /runs`, and carries the client's message naming the declared ones.
    // Anything else is rethrown for the same reason it is there: this catch used
    // to answer 400 with the raw message, so a read against a dead database
    // returned the whole `select … from "workflow"."workflow_runs"` statement to
    // an unauthenticated caller.
    if (!isWorkflowRequestError(err)) throw err;
    sendJson(res, 400, { error: err.message });
  }
}
