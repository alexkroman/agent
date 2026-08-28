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
import { omitUndefined } from "@alexkroman1/aai/utils";
import { isTerminal } from "@alexkroman1/aai/workflow-api";
import { isWorkflowRequestError } from "./_workflow-request-error.ts";
import type { Logger } from "./runtime-config.ts";
import { MAX_WORKFLOW_INPUT_BYTES, readBody, sendJson } from "./workflow-api-http.ts";
import { waitForRun } from "./workflow-api-wait.ts";
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
  const { workflow, input, key, wait } = (parsed ?? {}) as {
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
  ctx.logger.info("Workflow run started", {
    workflow,
    runId,
    ...omitUndefined({ key }),
  });
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
 */
export async function readRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: WorkflowApiEngine,
  runId: string,
): Promise<void> {
  const wait = Number(requestQuery(req.url).get("wait"));
  const run = runId
    ? await (clampWorkflowWait(wait) > 0 ? waitForRun(engine, runId, wait, res) : engine.get(runId))
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
 */
export async function wakeRun(
  res: http.ServerResponse,
  ctx: RouteContext,
  runId: string,
): Promise<void> {
  if (!runId) {
    sendJson(res, 404, { error: "No workflow run named" });
    return;
  }
  ctx.logger.info("Workflow run woken", { runId });
  sendJson(res, 200, { runId, woken: await ctx.engine.wakeUp(runId) });
}

/**
 * `GET /workflows/runs?workflow=<name>&key=<key>&limit=<n>` — runs of one
 * workflow, newest first.
 *
 * The query is read off `req.url` rather than the `url` argument, which the
 * server has already stripped of its query string — every other route here is an
 * exact or prefix path match, so this is the only one that needs it.
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
  const limitParam = params.get("limit");
  const limit = limitParam === null ? undefined : Number(limitParam);
  if (limit !== undefined && !Number.isFinite(limit)) {
    sendJson(res, 400, { error: "`limit` must be a number" });
    return;
  }
  const options = limit === undefined ? undefined : { limit };
  try {
    // `key` present narrows to that correlation key; absent lists the workflow's
    // recent runs whatever key they carry — the operator's read (a console has
    // no key to ask about, and an unkeyed run has none to be found by). Two
    // client methods rather than one nullable argument, so a caller meaning
    // "this session" cannot silently widen to every session.
    const runs = key
      ? await engine.find(workflow, key, options)
      : await engine.recent(workflow, options);
    sendJson(res, 200, { runs });
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
