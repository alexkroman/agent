// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow HTTP API — how a run is started, read and steered by something
 * that is not a tool.
 *
 * `ctx.workflows.start()` covers the case where a voice turn starts a run. This
 * covers the other two, which had no surface at all: a PAGE (a form, a
 * dashboard — see `AgentDef.page: "static"`) and a PROGRAMMATIC caller (a
 * script, a cron job, another service, `aai workflow`). Both want the same
 * things, so they get one surface rather than a page-only one plus an
 * integration story:
 *
 * ```
 * GET    /workflows                 → { workflows: WorkflowSummary[] }
 * POST   /workflows/runs            → { runId, run? }  body: { workflow, input?, key?, wait? }
 * GET    /workflows/runs            → { runs }    ?workflow=&key=&limit=
 * GET    /workflows/runs/:id        → a WorkflowRunSnapshot   ?wait=<ms>
 * DELETE /workflows/runs/:id        → { runId, cancelled }
 * GET    /workflows/runs/:id/events → SSE: run | done | missing | idle
 * GET    /workflows/runs/:id/stream → SSE: chunk | done | missing
 *                                     ?namespace=&startIndex=
 * POST   /workflows/runs/:id/wake   → { runId, woken }
 * ```
 *
 * ## `events` and `stream` are different questions about the same run
 *
 * `events` reports the run's STATE — the status transitions the world records,
 * which exist for every run whether or not it was written to. `stream` reports
 * what the run itself WROTE, through `getWritable()`, which is the only way a
 * long run can say anything before it finishes. A dashboard usually wants both:
 * one to know the run is alive, one to know what it is doing.
 *
 * ## Three ways to follow a run, and they are not alternatives
 *
 * `wait` makes the two read paths SYNCHRONOUS — one request in, one finished run
 * out — and is what a script, a cron job or a plain form wants, none of which
 * has anywhere to put an event stream. The SSE route is what a PAGE wants, since
 * a run can outlive any request. Polling `GET /runs/:id` is the floor both
 * degrade to. `workflow-api-wait.ts` carries the reasoning for the first,
 * `workflow-api-events.ts` for the second; the rule tying them together is that
 * waiting is an optimization over reading the run back, never the mechanism.
 *
 * It is mounted by `createServer`, so `aai dev`, a self-hosted server and every
 * deployed agent serve it identically — the same reasoning `/phone` is mounted
 * there rather than bolted onto the platform.
 *
 * ## There is no engine here, and every route is one `ctx.workflows` call
 *
 * That is the whole design and it is worth stating because the shape invites the
 * opposite. Runs, their history, replay, suspension and cancellation belong to
 * the Workflow Development Kit; `WorkflowClient` (`workflow-client.ts`) is the
 * translation over it, and this module is an HTTP spelling of that translation
 * and nothing more. A route that needed to read or write a run's internals
 * directly would be a sign the surface had grown an engine — the answer is a
 * client method, or the WDK's own API.
 *
 * It is also what the {@link WorkflowApiEngine} alias records: the engine this
 * API needs IS `WorkflowClient`, with nothing added.
 *
 * ## On authentication: this surface is as public as `/websocket` beside it
 *
 * A deliberate but real exposure. A page has no credential to present — it is
 * served to anyone who has the URL, exactly like the voice client — so requiring
 * one by default would mean no static page could ever work. The existing posture
 * is the same: anyone who knows a slug can open a voice session and spend the
 * tenant's provider budget. What is genuinely worse here is the COST SHAPE: a
 * run outlives the request that started it, and a loop of cheap POSTs can queue
 * far more work than a loop of voice sessions. So an operator who wants the
 * surface closed sets {@link WORKFLOW_API_TOKEN_ENV} in the agent env and every
 * route requires it as a bearer. Fail-OPEN when unset is the documented default,
 * not an oversight — see the `token` option.
 */

import type http from "node:http";
import { errorMessage } from "../sdk/utils.ts";
import { clampWorkflowWait, isTerminal } from "../sdk/workflow.ts";
import { WORKFLOWS_UNAVAILABLE_MESSAGE } from "../sdk/workflow-unavailable.ts";
import type { Logger } from "./runtime-config.ts";
import { streamRunEvents } from "./workflow-api-events.ts";
import {
  answerHandlerFailure,
  BodyTooLargeError,
  bearerMatches,
  MAX_WORKFLOW_INPUT_BYTES,
  readBody,
  sendJson,
} from "./workflow-api-http.ts";
import { streamRunOutput } from "./workflow-api-stream.ts";
import { waitForRun } from "./workflow-api-wait.ts";

export { MAX_WORKFLOW_INPUT_BYTES } from "./workflow-api-http.ts";

/** Path prefix every route here lives under. */
export const WORKFLOW_API_PREFIX = "/workflows";

/**
 * Env var holding the bearer this API requires. Unset leaves it open — see the
 * module doc.
 */
export const WORKFLOW_API_TOKEN_ENV = "AAI_WORKFLOW_API_TOKEN";

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
export type WorkflowApiEngine = import("../sdk/workflow.ts").WorkflowClient;

export type WorkflowApiOptions = {
  /**
   * Resolve the client, or undefined — in which case every route answers 404
   * rather than 500, since there is no workflow API to speak of.
   *
   * **Undefined has TWO causes and the answer must not pick one**: an agent that
   * declared no workflows, and an agent that declared some with nowhere to keep
   * the correlation index. Answering "this app declares no workflows" is a
   * confident false statement in the second case — and the second case is the
   * common one, because declaring a workflow is the part an author does not
   * forget. So the answer is `WORKFLOWS_UNAVAILABLE_MESSAGE`, which names both
   * halves and both fixes, and is the same sentence `ctx.workflows` rejects
   * with, so the tool path and this one cannot disagree about a condition they
   * share.
   *
   * A FUNCTION because the guest harness builds its runtime lazily, on the first
   * thing that needs it — and for a static app the first such thing is a request
   * to this API, not a session. Resolved per request, so it must stay cheap: the
   * harness's own getter memoizes.
   *
   * **It MAY THROW, and that is a different answer from `undefined`.** When a
   * guest cannot BUILD its runtime, swallowing the error and returning undefined
   * says "this app declares no workflows" about an app whose workflows are
   * declared and fine, while the real cause ("AssemblyAI LLM: missing API key")
   * reaches only the guest log — which the author of a deployed agent does not
   * have in front of them. A throw is reported as a 500 naming the cause; the
   * request still cannot crash the host, because the router catches it.
   */
  engine: () => WorkflowApiEngine | undefined;
  /**
   * Bearer required on every route. When undefined the API is OPEN — the
   * default, because a static page carries no credential (see the module doc).
   *
   * Comes from {@link WORKFLOW_API_TOKEN_ENV} in the agent's env, and it is what
   * `aai workflow --token` and the studio's runs card present.
   */
  token?: string | undefined;
  logger: Logger;
};

/** `POST /workflows/runs` — start a run and answer 202 with its id. */
async function startRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: WorkflowApiEngine,
): Promise<void> {
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
  // rather than 500s. Everything else is ours; the router's catch has it.
  let runId: string;
  try {
    runId = await engine.start(workflow, input, key === undefined ? undefined : { key });
  } catch (err) {
    sendJson(res, 400, { error: errorMessage(err) });
    return;
  }
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
  sendJson(res, isTerminal(run) ? 200 : 202, { runId, ...(run && { run }) });
}

/**
 * `GET /workflows/runs/:id` — read one run's state, optionally waiting it out.
 *
 * `?wait=<ms>` holds the request open until the run settles, which is how a
 * caller with an id resumes the synchronous mode after a `POST` that timed out.
 * The BODY is the same either way — a snapshot — so waiting is invisible to
 * anything that parses the answer.
 */
async function readRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: WorkflowApiEngine,
  runId: string,
): Promise<void> {
  const wait = Number(new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("wait"));
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
async function cancelRun(
  res: http.ServerResponse,
  engine: WorkflowApiEngine,
  runId: string,
): Promise<void> {
  if (!runId) {
    sendJson(res, 404, { error: "No workflow run named" });
    return;
  }
  // 200 with `cancelled: false` rather than a 4xx for a run that had already
  // finished: two tabs pressing Stop is ordinary, and "it was already over" is
  // an ANSWER. The client surfaces the distinction; nothing needs an error to.
  sendJson(res, 200, { runId, cancelled: await engine.cancel(runId) });
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
async function wakeRun(
  res: http.ServerResponse,
  engine: WorkflowApiEngine,
  runId: string,
): Promise<void> {
  if (!runId) {
    sendJson(res, 404, { error: "No workflow run named" });
    return;
  }
  sendJson(res, 200, { runId, woken: await engine.wakeUp(runId) });
}

/**
 * `GET /workflows/runs?workflow=<name>&key=<key>&limit=<n>` — runs of one
 * workflow, newest first.
 *
 * The query is read off `req.url` rather than the `url` argument, which the
 * server has already stripped of its query string — every other route here is an
 * exact or prefix path match, so this is the only one that needs it.
 */
async function findRuns(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: WorkflowApiEngine,
): Promise<void> {
  const params = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
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
    sendJson(res, 400, { error: errorMessage(err) });
  }
}

/** One route: the method and path shape it answers, and what it does. */
type Route = {
  method: string;
  matches: (url: string) => boolean;
  run: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    engine: WorkflowApiEngine,
    url: string,
  ) => Promise<void> | void;
};

/**
 * The routes, as a table rather than an if/else chain.
 *
 * Eight routes × (method, path shape) is well past the lint ceiling for
 * cognitive complexity as a chain, and a table also makes the PREFIX matches
 * visibly different from the exact ones.
 *
 * **Order is load-bearing** wherever a longer path starts with a shorter one:
 * `/runs/<id>/events` begins with the `/runs/` prefix, so a bare `/runs/:id`
 * rule listed first would read `"<id>/events"` as a run id and answer 404 for a
 * run that exists.
 */
function buildRoutes(): Route[] {
  const runsPrefix = `${WORKFLOW_API_PREFIX}/runs/`;
  const runId = (url: string, suffix = ""): string =>
    decodeURIComponent(url.slice(runsPrefix.length, suffix ? -suffix.length : undefined));
  return [
    {
      method: "GET",
      matches: (url) => url === WORKFLOW_API_PREFIX,
      run: (_req, res, engine) => sendJson(res, 200, { workflows: engine.listing() }),
    },
    {
      method: "POST",
      matches: (url) => url === `${WORKFLOW_API_PREFIX}/runs`,
      run: (req, res, engine) => startRun(req, res, engine),
    },
    // Before the `/runs/:id` prefix matches below, and distinct from them: the
    // collection path carries no id, so it cannot be confused with a run whose
    // id is the empty string.
    {
      method: "GET",
      matches: (url) => url === `${WORKFLOW_API_PREFIX}/runs`,
      run: (req, res, engine) => findRuns(req, res, engine),
    },
    {
      method: "GET",
      matches: (url) => url.startsWith(runsPrefix) && url.endsWith("/events"),
      run: (_req, res, engine, url) => {
        streamRunEvents(res, engine, runId(url, "/events"));
      },
    },
    // Same rule as `/events` above: a longer path that starts with the `/runs/`
    // prefix has to be listed before the bare `/runs/:id` rule, or its whole
    // suffix is read as part of the run id and the answer is a 404 for a run
    // that exists.
    {
      method: "GET",
      matches: (url) => url.startsWith(runsPrefix) && url.endsWith("/stream"),
      run: (req, res, engine, url) => streamRunOutput(req, res, engine, runId(url, "/stream")),
    },
    {
      method: "GET",
      matches: (url) => url.startsWith(runsPrefix),
      run: (req, res, engine, url) => readRun(req, res, engine, runId(url)),
    },
    // The POST collection route is an exact match on `/runs`, so this cannot be
    // confused with it — but it still has to precede nothing, since it is the
    // only POST under the `/runs/` prefix.
    {
      method: "POST",
      matches: (url) => url.startsWith(runsPrefix) && url.endsWith("/wake"),
      run: (_req, res, engine, url) => wakeRun(res, engine, runId(url, "/wake")),
    },
    {
      method: "DELETE",
      matches: (url) => url.startsWith(runsPrefix),
      run: (_req, res, engine, url) => cancelRun(res, engine, runId(url)),
    },
  ];
}

/**
 * Create the workflow API request handler.
 *
 * The returned function matches `ServerOptions.request`: it returns true when it
 * has CLAIMED the request (the caller must then leave the response alone) and
 * false to fall through. Claiming is synchronous even though handling is not —
 * the response is answered from the promise, including on failure, so a claimed
 * request always gets exactly one answer.
 *
 * @internal
 */
export function createWorkflowApi(
  opts: WorkflowApiOptions,
): (req: http.IncomingMessage, res: http.ServerResponse, url: string, method: string) => boolean {
  const { engine: resolveEngine, token, logger } = opts;
  const routes = buildRoutes();

  async function route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): Promise<void> {
    // The token is checked BEFORE the engine is resolved: resolving builds the
    // runtime in the guest, which is work an unauthenticated caller must not be
    // able to trigger.
    if (token !== undefined && !bearerMatches(req.headers.authorization, token)) {
      sendJson(res, 401, { error: "Missing or invalid workflow API token" });
      return;
    }
    // A resolver that THREW could not build the runtime — a misconfigured agent,
    // not an agent without workflows — so it answers 500 with the reason rather
    // than the 404 below, which would deny that the workflows exist.
    let engine: WorkflowApiEngine | undefined;
    try {
      engine = resolveEngine();
    } catch (err) {
      logger.error("Workflow API unavailable", { error: errorMessage(err) });
      sendJson(res, 500, { error: `Workflow API unavailable: ${errorMessage(err)}` });
      return;
    }
    if (!engine) {
      // The SAME sentence `ctx.workflows` rejects with, because it is the same
      // condition and it has two causes — see the option's doc.
      sendJson(res, 404, { error: WORKFLOWS_UNAVAILABLE_MESSAGE });
      return;
    }
    const matched = routes.find((r) => r.method === method && r.matches(url));
    if (!matched) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    await matched.run(req, res, engine, url);
  }

  return (req, res, url, method) => {
    if (url !== WORKFLOW_API_PREFIX && !url.startsWith(`${WORKFLOW_API_PREFIX}/`)) return false;
    route(req, res, url, method).catch((err: unknown) => {
      // 413 rather than 400 or 500: the request was well-formed and too big, and
      // a caller has to tell "this input is too large" apart from "the agent is
      // broken". Mapped HERE rather than in the route that reads a body, so a
      // second body-reading route cannot forget it.
      if (err instanceof BodyTooLargeError && !res.headersSent) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      answerHandlerFailure(res, logger, "Workflow API request failed", errorMessage(err));
    });
    return true;
  };
}
