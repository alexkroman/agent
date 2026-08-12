// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow HTTP API — how a run is started by something that is not a tool.
 *
 * `ctx.workflows.start()` covers the case where a voice turn starts a run. This
 * covers the other two, which had no surface at all: a PAGE (a form, an upload,
 * a dashboard — see `AgentDef.page: "static"`) and a PROGRAMMATIC caller (a
 * script, a cron job, another service). Both want the same four things, so they
 * get one surface rather than a page-only one plus an integration story:
 *
 * ```
 * GET    /workflows            → { workflows: [{ name, description? }] }
 * POST   /workflows/runs       → { runId }         body: { workflow, input?, key? }
 * GET    /workflows/runs       → { runs }          ?workflow=&key=&limit=
 * GET    /workflows/runs/:id   → a WorkflowRunSnapshot
 * DELETE /workflows/runs/:id   → { runId, cancelled }
 * GET    /workflows/runs/:id/events → SSE: run | done | missing | idle
 * POST   /workflows/runs/:id/retry → { runId, retried }
 * POST   /workflows/signals/:token  → { signalled, runId? }  body: the payload
 * POST   /workflows/blobs      → { blobId, bytes } body: raw bytes
 * ```
 *
 * It is mounted by `createServer`, so `aai dev`, a self-hosted server and every
 * deployed agent serve it identically — the same reasoning `/phone` is mounted
 * there rather than bolted onto the platform.
 *
 * **`/blobs` is the one route whose existence needs explaining.** A run's input
 * is journaled, and replay reads the whole journal back through `ctx.db` on
 * every resume, so bytes may not travel in it (see `WorkflowStore.putBlob`).
 * A browser cannot reach `ctx.db` to put them anywhere else. So an upload lands
 * in a blob, the run is started naming the blob's id, and the workflow reads it
 * with ordinary SQL against its own schema.
 *
 * **On authentication: this surface is as public as `/websocket` beside it, and
 * that is a deliberate but real exposure.** A page has no credential to present
 * — it is served to anyone who has the URL, exactly like the voice client — so
 * requiring one by default would mean no static page could ever work. The
 * existing posture is the same: anyone who knows a slug can open a voice session
 * and spend the tenant's provider budget. What is genuinely worse here is the
 * COST SHAPE: a run outlives the request that started it and a loop of cheap
 * POSTs can queue far more work than a loop of voice sessions. So an operator
 * who wants the surface closed sets `AAI_WORKFLOW_API_TOKEN` in the agent env
 * and every route requires it as a bearer. Fail-OPEN when unset is the
 * documented default, not an oversight — see the `token` option.
 */

import type http from "node:http";
import { errorMessage } from "../sdk/utils.ts";
import { WORKFLOWS_UNAVAILABLE_MESSAGE } from "../sdk/workflow-limits.ts";
import type { Logger } from "./runtime-config.ts";
import { streamRunEvents } from "./workflow-api-events.ts";
import {
  BodyTooLargeError,
  bearerMatches,
  MAX_WORKFLOW_INPUT_BYTES,
  readBody,
  type ScopedApiEngine,
  sendJson,
  type WorkflowApiEngine,
} from "./workflow-api-http.ts";

import { cancelRun, retryRun, signalWait } from "./workflow-api-mutations.ts";

/**
 * Re-exported so the public import paths are unchanged. They LIVE in
 * `workflow-api-http.ts` because the mutation handlers need both, and importing
 * them from here would close a cycle — this module imports those handlers.
 */
export {
  MAX_WORKFLOW_INPUT_BYTES,
  type ScopedApiEngine,
  type WorkflowApiEngine,
} from "./workflow-api-http.ts";
/** Path prefix every route here lives under. */
export const WORKFLOW_API_PREFIX = "/workflows";

/**
 * Env var holding the bearer this API requires. Unset leaves it open — see the
 * module doc.
 */
export const WORKFLOW_API_TOKEN_ENV = "AAI_WORKFLOW_API_TOKEN";

/**
 * Largest single blob.
 *
 * Sized against what a caller can usefully do with one rather than against the
 * database: AssemblyAI's Sync API takes at most 120 s / 40 MB per request, and
 * 120 s of 16 kHz mono PCM is ~3.8 MB, so this clears the realistic chunk by
 * several times while keeping one request's peak memory bounded.
 */
export const MAX_WORKFLOW_BLOB_BYTES = 16 * 1024 * 1024;

export type WorkflowApiOptions = {
  /**
   * Resolve the engine, or undefined — in which case every route answers 404
   * rather than 500, since there is no workflow API to speak of.
   *
   * **Undefined has TWO causes and the answer must not pick one**
   * (`setupWorkflows` in `runtime-tools.ts`): an agent that declared no
   * workflows, and an agent that declared some with no storage for the journal.
   * This used to answer `"This app declares no workflows"`, which is a
   * confident false statement in the second case — and the second case is the
   * common one, because declaring a workflow is the part an author does not
   * forget. A deployed `transcription-desk` with storage off reported it for
   * every upload, and the sentence sends its reader to look at the code they
   * just wrote correctly. So the answer is `WORKFLOWS_UNAVAILABLE_MESSAGE`,
   * which names both halves and both fixes — the same sentence `ctx.workflows`
   * rejects with, so the tool path and this one cannot disagree about a
   * condition they share. Narrowing it further would take a second signal from
   * the resolver; naming both costs nothing and cannot be wrong.
   *
   * A FUNCTION because the guest harness builds its runtime lazily, on the
   * first thing that needs it (see `lazyRuntime` in `aai-guest/harness.ts`) —
   * and for a static app the first such thing is a request to this API, not a
   * session. Resolved per request, so it must stay cheap: the harness's own
   * getter is memoized.
   *
   * **It MAY THROW, and that is a different answer from `undefined`.** The two
   * were conflated and the resulting message was actively misleading: when a
   * guest could not BUILD its runtime, the harness swallowed the error and
   * returned undefined, so the API said "This app declares no workflows" about
   * an app whose workflows were declared and fine, while the real cause
   * ("AssemblyAI LLM: missing API key") reached only the guest log — which the
   * author of a deployed agent does not have in front of them. A throw is
   * reported as a 500 naming the cause; the request still cannot crash the
   * guest, because {@link createWorkflowApi}'s router catches it.
   */
  engine: () => WorkflowApiEngine | undefined;
  /**
   * Resolve WHO is calling, from the request.
   *
   * The per-user half of this API. Without it the only posture available is
   * all-or-nothing (`token` below, one shared bearer), and a shared bearer in a
   * browser bundle is not a secret — so a page could serve a public toy or a
   * single-tenant internal tool and nothing with a notion of *this user's* runs.
   *
   * The SDK deliberately supplies NO user model: these are the app's users, and
   * binding them to a provider of ours would couple every deployed agent's auth to
   * it. Verify whatever the app already has — its own JWT, a session cookie checked
   * through `ctx.db`, a header its proxy sets — and return a stable id.
   *
   * **Declaring it makes this API fail CLOSED**: a request that is neither
   * identified nor the operator (see `token`) is refused, where an app with no
   * `identify` serves everyone. Returning `undefined` means "not identified", which
   * is a 401, not an unscoped read.
   *
   * A run is stamped with the scope that STARTED it and every read and mutation
   * filters on it, so one user cannot see, cancel, retry or signal another's run.
   * Runs created before an app declared this carry no scope and are invisible to a
   * scoped caller — handing them to whichever user asks first is the leak the
   * mechanism exists to prevent.
   */
  identify?:
    | ((req: http.IncomingMessage) => Promise<string | undefined> | string | undefined)
    | undefined;
  /**
   * Bearer required on every route. When undefined the API is OPEN — the
   * default, because a static page carries no credential (see the module doc).
   *
   * With `identify` declared this becomes the OPERATOR credential: a request
   * carrying it reads and steers every run regardless of scope, which is what
   * `aai workflow runs` and the studio card need.
   * Comes from {@link WORKFLOW_API_TOKEN_ENV} in the agent's env.
   */
  token?: string | undefined;
  logger: Logger;
};

async function startRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: ScopedApiEngine,
): Promise<void> {
  const body = await readBody(req, MAX_WORKFLOW_INPUT_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "Body must be JSON" });
    return;
  }
  const { workflow, input, key } = (parsed ?? {}) as {
    workflow?: unknown;
    input?: unknown;
    key?: unknown;
  };
  if (typeof workflow !== "string") {
    sendJson(res, 400, { error: 'Body must name a workflow: { "workflow": "<name>", input? }' });
    return;
  }
  // Refused rather than coerced: a non-string key would be stored as whatever
  // `String()` made of it and then never match the `find` a caller writes.
  if (key !== undefined && typeof key !== "string") {
    sendJson(res, 400, { error: '"key" must be a string when present' });
    return;
  }
  // `start` rejects an unknown name and an input failing the workflow's own
  // schema, and both are the CALLER's mistake — so they are 400s carrying the
  // engine's message (which names the declared workflows, or the schema issues)
  // rather than 500s. Everything else is ours; the router's catch has it.
  let runId: string;
  try {
    runId = await engine.start(workflow, input, key === undefined ? undefined : { key });
  } catch (err) {
    sendJson(res, 400, { error: errorMessage(err) });
    return;
  }
  // 202: the run is durable, and deliberately not finished — that is the whole
  // point of the mechanism (see `WorkflowClient.start`).
  sendJson(res, 202, { runId });
}

/** `POST /workflows/blobs` — store raw bytes for a run to work on. */
async function putBlob(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: ScopedApiEngine,
): Promise<void> {
  // An over-limit body answers 413 through the router's own mapping — see the
  // `BodyTooLargeError` branch there.
  const body = await readBody(req, MAX_WORKFLOW_BLOB_BYTES);
  if (body.length === 0) {
    sendJson(res, 400, { error: "Blob body is empty" });
    return;
  }
  const contentType = req.headers["content-type"] ?? "application/octet-stream";
  sendJson(res, 201, {
    blobId: await engine.putBlob(contentType, body.toString("base64")),
    bytes: body.length,
  });
}

/** `GET /workflows/runs/:id` — read one run's state. */
async function readRun(
  res: http.ServerResponse,
  engine: ScopedApiEngine,
  runId: string,
): Promise<void> {
  const run = runId ? await engine.get(runId) : undefined;
  if (!run) {
    sendJson(res, 404, { error: `No workflow run with id ${runId}` });
    return;
  }
  sendJson(res, 200, run);
}

/**
 * `GET /workflows/runs?workflow=<name>&key=<key>` — runs carrying a correlation
 * key, newest first.
 *
 * The query is read off `req.url` rather than the `url` argument, which the server
 * has already stripped of its query string (`server.ts` splits on `?` before
 * dispatching) — every other route here is an exact path match, so this is the
 * first one that needs it.
 */
async function findRuns(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: ScopedApiEngine,
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
  // An unknown workflow name is the caller's mistake, exactly as it is on
  // `POST /runs`, and carries the engine's message naming the declared ones.
  const options = limit === undefined ? undefined : { limit };
  try {
    // `key` present narrows to that correlation key; absent lists the workflow's
    // recent runs whatever key they carry — the operator's read (a console has no
    // key to ask about, and an unkeyed run has none to be found by). Two methods
    // rather than one nullable argument, so a caller meaning "this session" cannot
    // silently widen to every session — see `WorkflowClient.recent`.
    const runs = key
      ? await engine.find(workflow, key, options)
      : await engine.recent(workflow, options);
    sendJson(res, 200, { runs });
  } catch (err) {
    sendJson(res, 400, { error: errorMessage(err) });
  }
}

/**
 * Create the workflow API request handler.
 *
 * The returned function matches `ServerOptions.request`: it returns true when
 * it has CLAIMED the request (the caller must then leave the response alone)
 * and false to fall through. Claiming is synchronous even though handling is
 * not — the response is answered from the promise, including on failure, so a
 * claimed request always gets exactly one answer.
 *
 * @internal
 */
export function createWorkflowApi(
  opts: WorkflowApiOptions,
): (req: http.IncomingMessage, res: http.ServerResponse, url: string, method: string) => boolean {
  const { engine: resolveEngine, token, identify, logger } = opts;
  const runsPrefix = `${WORKFLOW_API_PREFIX}/runs/`;
  const signalsPrefix = `${WORKFLOW_API_PREFIX}/signals/`;

  /**
   * The routes, as a table rather than an if/else chain.
   *
   * The chain was over the lint ceiling for cognitive complexity, and fairly:
   * four routes × (method, path shape) is eight conditions in one function. A
   * table also makes the ONE prefix match (`/runs/:id`) visibly different from
   * the three exact ones.
   */
  const routes: {
    method: string;
    matches: (url: string) => boolean;
    run: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      engine: ScopedApiEngine,
      url: string,
    ) => Promise<void> | void;
  }[] = [
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
    // Before the `/runs/:id` prefix match below, and distinct from it: the
    // collection path carries no id, so it cannot be confused with a run whose id
    // is the empty string.
    {
      method: "GET",
      matches: (url) => url === `${WORKFLOW_API_PREFIX}/runs`,
      run: (req, res, engine) => findRuns(req, res, engine),
    },
    {
      // Ordered BEFORE the bare `/runs/:id` GET below, for the same reason the
      // retry route precedes the DELETE: `/runs/<id>/events` starts with the
      // prefix, so a prefix rule listed first would read "<id>/events" as an id.
      method: "GET",
      matches: (url) => url.startsWith(runsPrefix) && url.endsWith("/events"),
      run: (_req, res, engine, url) => {
        streamRunEvents(
          res,
          engine,
          decodeURIComponent(url.slice(runsPrefix.length, -"/events".length)),
        );
        return Promise.resolve();
      },
    },
    {
      method: "GET",
      matches: (url) => url.startsWith(runsPrefix),
      run: (_req, res, engine, url) =>
        readRun(res, engine, decodeURIComponent(url.slice(runsPrefix.length))),
    },
    {
      // Ordered BEFORE the bare `/runs/:id` matches below, for the same reason the
      // exact `/runs` match precedes them: `/runs/<id>/retry` starts with the
      // prefix, so a prefix rule listed first would read "<id>/retry" as an id.
      method: "POST",
      matches: (url) => url.startsWith(runsPrefix) && url.endsWith("/retry"),
      run: (_req, res, engine, url) =>
        retryRun(res, engine, decodeURIComponent(url.slice(runsPrefix.length, -"/retry".length))),
    },
    {
      method: "DELETE",
      matches: (url) => url.startsWith(runsPrefix),
      run: (_req, res, engine, url) =>
        cancelRun(res, engine, decodeURIComponent(url.slice(runsPrefix.length))),
    },
    {
      method: "POST",
      matches: (url) => url.startsWith(signalsPrefix),
      run: (req, res, engine, url) =>
        signalWait(req, res, engine, decodeURIComponent(url.slice(signalsPrefix.length))),
    },
    {
      method: "POST",
      matches: (url) => url === `${WORKFLOW_API_PREFIX}/blobs`,
      run: (req, res, engine) => putBlob(req, res, engine),
    },
  ];

  /**
   * Who is calling, and may they call at all?
   *
   * Three postures, and conflating them is the bug this exists to prevent. An app
   * with neither `token` nor `identify` serves everyone unscoped — the documented
   * default, since a static page carries no credential. An app with `token` alone
   * is all-or-nothing. An app with `identify` fails CLOSED: a caller who is
   * neither the OPERATOR (holding `token`, which is the app's credential and what
   * `aai workflow` and the studio card use) nor identified is refused, rather than
   * served an unscoped view of every user's runs.
   *
   * Its own function so `route` stays under the cognitive-complexity cap, and
   * because "is this request allowed, and as whom" is one decision that should be
   * readable in one place.
   */
  async function authorize(
    req: http.IncomingMessage,
  ): Promise<{ ok: true; scope: string | undefined } | { ok: false; error: string }> {
    const isOperator = token !== undefined && bearerMatches(req.headers.authorization, token);
    if (isOperator) return { ok: true, scope: undefined };
    if (token !== undefined && identify === undefined) {
      return { ok: false, error: "Missing or invalid workflow API token" };
    }
    if (identify === undefined) return { ok: true, scope: undefined };
    let scope: string | undefined;
    try {
      scope = (await identify(req)) ?? undefined;
    } catch (err) {
      // An `identify` that threw has authorized nobody. Logged because it is the
      // app's own code failing, and answered 401 rather than 500: the outcome is
      // the same from the caller's side, and a 500 invites a retry loop.
      logger.error("Workflow API identify failed", { error: errorMessage(err) });
    }
    return scope === undefined
      ? { ok: false, error: "Not authenticated for this app's workflows" }
      : { ok: true, scope };
  }

  async function route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): Promise<void> {
    // The token is checked BEFORE the engine is resolved: resolving builds the
    // runtime in the guest, which is work an unauthenticated caller must not be
    // able to trigger.
    const authorized = await authorize(req);
    if (!authorized.ok) {
      sendJson(res, 401, { error: authorized.error });
      return;
    }
    const scope = authorized.scope;
    // A resolver that THREW could not build the runtime — a misconfigured agent,
    // not an agent without workflows — so it answers 500 with the reason rather
    // than the 404 below, which would deny that the workflows exist. See
    // `WorkflowApiOptions.engine`.
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
    // The SCOPED engine — every read and mutation the handler makes is filtered to
    // this caller. Unscoped for an app with no `identify`, and for the operator.
    await matched.run(req, res, engine.scoped(scope), url);
  }

  return (req, res, url, method) => {
    if (url !== WORKFLOW_API_PREFIX && !url.startsWith(`${WORKFLOW_API_PREFIX}/`)) return false;
    route(req, res, url, method).catch((err: unknown) => {
      // 413 rather than 400 or 500: the request was well-formed and too big, and
      // a page chunking an upload has to tell "this file is too big" apart from
      // "the agent is broken". Mapped HERE rather than in each route that reads a
      // body, because the route that forgot to is exactly how this was found —
      // `POST /workflows/runs` answered an over-limit input with an opaque 500
      // while `/blobs` answered 413, from two copies of one decision.
      if (err instanceof BodyTooLargeError && !res.headersSent) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      logger.error("Workflow API request failed", { error: errorMessage(err) });
      try {
        if (res.headersSent) res.destroy();
        else sendJson(res, 500, { error: "Internal server error" });
      } catch {
        res.destroy();
      }
    });
    return true;
  };
}
