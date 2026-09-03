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
 * POST   /workflows/runs/:id/wake   → { runId, woken }   ?correlationId=
 * POST   /workflows/uploads         → { id, …, complete }   body: the file
 * PUT    /workflows/uploads/:id     → the same, under an id the CALLER chose
 * POST   /workflows/uploads/:id/parts  → declare an upload its parts fill in
 * PUT    /workflows/uploads/:id/parts  → one window of it, at `?offset=`
 * GET    /workflows/uploads/:id     → the bytes, `Range` honoured
 * GET    /workflows/uploads/:id/info → { id, name, type, size, complete }
 * ```
 *
 * ## The uploads pair is the one part that is not about runs
 *
 * A run's input is journaled and replayed, so bytes may not travel in it — which
 * left a form with nowhere to put a file and no honest option but to ask for a
 * URL. `workflow-api-uploads.ts` (the writes) and `workflow-api-uploads-read.ts`
 * (the two `GET`s) are the answer, and their own modules for exactly that reason:
 * they touch the store and never the engine, so the rule below ("every route is
 * one `ctx.workflows` call") keeps meaning what it says.
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
 * Fail-OPEN when unset is the documented default, not an oversight, and an
 * operator closes the surface with {@link WORKFLOW_API_TOKEN_ENV}. The POSTURE —
 * three separate exposure shapes, which of them a rate limit bounds, and why the
 * unkeyed arm of `GET /runs` is the hinge the other two rest on — is
 * `workflow-api-auth.ts`. It used to be a paragraph here that named only the
 * cost shape, which is the one exposure that already has a mitigation.
 */

import type http from "node:http";
import { WORKFLOWS_UNAVAILABLE_MESSAGE } from "@alexkroman1/aai/host-internal";
import { WORKFLOW_API_PREFIX } from "@alexkroman1/aai/internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import { runIdOr400 } from "./_workflow-run-id.ts";
import type { Logger } from "./runtime-config.ts";
import { workflowApiUnauthorized } from "./workflow-api-auth.ts";
import { workflowApiErrorStatus } from "./workflow-api-error-status.ts";
import { streamRunEvents } from "./workflow-api-events.ts";
import { claimUnder, sendJson } from "./workflow-api-http.ts";
import {
  cancelRun,
  findRuns,
  type RouteContext,
  readRun,
  startRun,
  type WorkflowApiEngine,
  wakeRun,
} from "./workflow-api-runs.ts";
import { streamRunOutput } from "./workflow-api-stream.ts";
import {
  beginUploadParts,
  createUpload,
  streamUpload,
  UPLOAD_PARTS_SUFFIX,
  UPLOADS_PATH,
  uploadIdOr400,
  writeUploadPart,
} from "./workflow-api-uploads.ts";
import { readUploadInfoRoute, readUploadRoute } from "./workflow-api-uploads-read.ts";
import type { UploadStore } from "./workflow-uploads.ts";

/**
 * Path prefix every route here lives under.
 *
 * Re-exported rather than declared: it is defined beside the CLIENT
 * (`sdk/workflow-api-client.ts`) because a browser cannot import this half, and
 * one literal for both ends is what keeps a client asking for a path this server
 * does not serve from being a 404 that reads as a missing feature. Existing
 * consumers — `@alexkroman1/aai-runtime`, and the `aai dev` proxy table through
 * it — are unaffected.
 */
export { WORKFLOW_API_PREFIX } from "@alexkroman1/aai/internal";
// Re-exported, not moved out of the public surface: the constant is declared
// beside the posture that explains it, and this stays the import path every
// consumer (and the `aai-runtime:workflow` contract) already names.
export { WORKFLOW_API_TOKEN_ENV } from "./workflow-api-auth.ts";
export { MAX_WORKFLOW_INPUT_BYTES } from "./workflow-api-http.ts";

// Re-exported: the alias is part of this API's own vocabulary (`engine` below
// is typed with it), and it is declared beside the handlers that consume it.
export type { RouteContext, WorkflowApiEngine } from "./workflow-api-runs.ts";

/** The SERVER's options, not aai-ui's same-named client ones. @internal */
export type WorkflowApiOptions = {
  /**
   * Resolve the client, or undefined — in which case every route answers 404
   * rather than 500, since there is no workflow API to speak of.
   *
   * **Undefined has exactly ONE cause: the agent declared no workflows.** This
   * paragraph used to claim two — the second being "declared some with nowhere to
   * keep the correlation index" — and argued from there that answering "this app
   * declares no workflows" would be "a confident false statement in the second
   * case", which it called the common one. There is no second case.
   * `buildWorkflowClient` returns undefined on one condition
   * (`!workflows || Object.keys(workflows).length === 0`), and
   * `workflow-runtime.ts` states the rest outright: "A missing database is
   * therefore NOT a reason to withhold the client."
   *
   * So the answer is `WORKFLOWS_UNAVAILABLE_MESSAGE`, which names that one cause
   * and its one fix, and is the same sentence `ctx.workflows` rejects with, so
   * the tool path and this one cannot disagree about a condition they share. The
   * message was corrected to name one cause; this doc was the holdout still
   * arguing that doing so was a mistake.
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
  /**
   * Where uploaded files are kept, for the two `/uploads` routes.
   *
   * A VALUE rather than the getter `engine` is, because a store is cheap to
   * build and connects lazily — there is no runtime behind it to defer. Absent,
   * the pair 404s naming the reason; `createServer` always passes one.
   */
  uploads?: UploadStore | undefined;
  /**
   * Whether a part's bytes should be sent somewhere OTHER than this server.
   *
   * True when the store reaches its bytes through a platform that also serves them
   * a route of its own — a deployed guest, which holds no bucket credential and
   * brokers every byte operation. The `/parts` claim then advertises it, and the
   * client sends each window to the platform and reports it here with no body, so
   * an upload byte never touches this process at all.
   *
   * A CAPABILITY of the deployment rather than a fact about the file, which is why
   * the claim carries it instead of a client guessing: `aai dev` and a self-hosted
   * server hold the credential themselves and have no such route, so their clients
   * must keep sending bodies here.
   */
  directParts?: boolean | undefined;
  logger: Logger;
};

/** One route: the method and path shape it answers, and what it does. */
type Route = {
  method: string;
  matches: (url: string) => boolean;
  run: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: RouteContext,
    url: string,
  ) => Promise<void> | void;
};

/** The store, or the 404 a server without one owes. */
function requireUploads(res: http.ServerResponse, ctx: RouteContext): UploadStore | undefined {
  if (ctx.uploads) return ctx.uploads;
  sendJson(res, 404, {
    error:
      "This server stores no uploads. They are served by `createServer`, which every deployed " +
      "agent and `aai dev` go through.",
  });
  return undefined;
}

/** Prefix every `/runs/:id` route matches under. */
const RUNS_PREFIX = `${WORKFLOW_API_PREFIX}/runs/`;

/**
 * The routes, as a table rather than an if/else chain.
 *
 * Fourteen routes × (method, path shape) is well past the lint ceiling for
 * cognitive complexity as a chain, and a table also makes the PREFIX matches
 * visibly different from the exact ones.
 *
 * **Order is load-bearing** wherever a longer path starts with a shorter one:
 * `/runs/<id>/events` begins with the `/runs/` prefix, so a bare `/runs/:id`
 * rule listed first would read `"<id>/events"` as a run id and answer 404 for a
 * run that exists. That ordering is a property of the TABLE, which is why the
 * table is a module constant built once rather than a per-instance array: every
 * entry closes over nothing, and rebuilding fourteen route objects per
 * `createWorkflowApi` (and re-scanning a fresh array per request) bought
 * nothing.
 */
const ROUTES: readonly Route[] = [
  {
    method: "GET",
    matches: (url) => url === WORKFLOW_API_PREFIX,
    run: (_req, res, ctx) => sendJson(res, 200, { workflows: ctx.engine.listing() }),
  },
  {
    method: "POST",
    matches: (url) => url === `${WORKFLOW_API_PREFIX}/runs`,
    run: (req, res, ctx) => startRun(req, res, ctx),
  },
  // Before the `/runs` rules only for readability — `/uploads` shares no
  // prefix with them, so nothing here depends on the order.
  {
    method: "POST",
    matches: (url) => url === UPLOADS_PATH,
    run: async (req, res, ctx) => {
      const store = requireUploads(res, ctx);
      if (store) await createUpload(req, res, store, ctx.logger);
    },
  },
  // BEFORE the bare `/uploads/:id` rule below, which is a PREFIX match — listed
  // the other way round it reads `"<id>/info"` as an upload id and 404s an upload
  // that exists. Same order-is-load-bearing rule as `/runs/:id/events`.
  // The `/parts` pair is under the same prefix-order rule as `/info` below: both
  // paths end in a suffix the bare `/uploads/:id` rules would read as part of the
  // id, so they are listed first.
  {
    method: "POST",
    matches: (url) => url.startsWith(`${UPLOADS_PATH}/`) && url.endsWith(UPLOAD_PARTS_SUFFIX),
    run: async (req, res, ctx, url) => {
      const store = requireUploads(res, ctx);
      if (!store) return;
      const id = uploadIdOr400(res, url, UPLOAD_PARTS_SUFFIX);
      if (id !== undefined) {
        await beginUploadParts(req, res, store, id, ctx.logger, ctx.directParts === true);
      }
    },
  },
  {
    method: "PUT",
    matches: (url) => url.startsWith(`${UPLOADS_PATH}/`) && url.endsWith(UPLOAD_PARTS_SUFFIX),
    run: async (req, res, ctx, url) => {
      const store = requireUploads(res, ctx);
      if (!store) return;
      const id = uploadIdOr400(res, url, UPLOAD_PARTS_SUFFIX);
      if (id !== undefined) await writeUploadPart(req, res, store, id);
    },
  },
  {
    method: "GET",
    matches: (url) => url.startsWith(`${UPLOADS_PATH}/`) && url.endsWith("/info"),
    run: async (_req, res, ctx, url) => {
      const store = requireUploads(res, ctx);
      if (!store) return;
      const id = uploadIdOr400(res, url, "/info");
      if (id !== undefined) await readUploadInfoRoute(res, store, id, ctx.directParts === true);
    },
  },
  {
    method: "GET",
    matches: (url) => url.startsWith(`${UPLOADS_PATH}/`),
    run: async (req, res, ctx, url) => {
      const store = requireUploads(res, ctx);
      if (!store) return;
      const id = uploadIdOr400(res, url);
      if (id !== undefined) await readUploadRoute(req, res, store, id);
    },
  },
  {
    method: "PUT",
    matches: (url) => url.startsWith(`${UPLOADS_PATH}/`),
    run: async (req, res, ctx, url) => {
      const store = requireUploads(res, ctx);
      if (!store) return;
      const id = uploadIdOr400(res, url);
      if (id !== undefined) await streamUpload(req, res, store, id, ctx.logger);
    },
  },
  // Before the `/runs/:id` prefix matches below, and distinct from them: the
  // collection path carries no id, so it cannot be confused with a run whose
  // id is the empty string.
  {
    method: "GET",
    matches: (url) => url === `${WORKFLOW_API_PREFIX}/runs`,
    run: (req, res, ctx) => findRuns(req, res, ctx.engine),
  },
  {
    method: "GET",
    matches: (url) => url.startsWith(RUNS_PREFIX) && url.endsWith("/events"),
    run: (_req, res, ctx, url) => {
      const id = runIdOr400(res, url, RUNS_PREFIX, "/events");
      if (id !== undefined) streamRunEvents(res, ctx.engine, id, { logger: ctx.logger });
    },
  },
  // Same rule as `/events` above: a longer path that starts with the `/runs/`
  // prefix has to be listed before the bare `/runs/:id` rule, or its whole
  // suffix is read as part of the run id and the answer is a 404 for a run
  // that exists.
  {
    method: "GET",
    matches: (url) => url.startsWith(RUNS_PREFIX) && url.endsWith("/stream"),
    run: (req, res, ctx, url) => {
      const id = runIdOr400(res, url, RUNS_PREFIX, "/stream");
      if (id !== undefined) return streamRunOutput(req, res, ctx.engine, id);
    },
  },
  {
    method: "GET",
    matches: (url) => url.startsWith(RUNS_PREFIX),
    run: (req, res, ctx, url) => {
      const id = runIdOr400(res, url, RUNS_PREFIX);
      if (id !== undefined) return readRun(req, res, ctx.engine, id);
    },
  },
  // The POST collection route is an exact match on `/runs`, so this cannot be
  // confused with it — but it still has to precede nothing, since it is the
  // only POST under the `/runs/` prefix.
  {
    method: "POST",
    matches: (url) => url.startsWith(RUNS_PREFIX) && url.endsWith("/wake"),
    run: (req, res, ctx, url) => {
      const id = runIdOr400(res, url, RUNS_PREFIX, "/wake");
      // `req`, because the correlation ids that make a wake TARGETED come off
      // the query string — see `wakeRun`.
      if (id !== undefined) return wakeRun(req, res, ctx, id);
    },
  },
  {
    method: "DELETE",
    matches: (url) => url.startsWith(RUNS_PREFIX),
    run: (_req, res, ctx, url) => {
      const id = runIdOr400(res, url, RUNS_PREFIX);
      if (id !== undefined) return cancelRun(res, ctx, id);
    },
  },
];

/**
 * The HTTP methods this API answers, DERIVED from {@link ROUTES} — sorted, so a
 * comparison against it is stable.
 *
 * Exported for the same reason `WORKFLOW_API_PREFIX` is: the platform must
 * proxy this surface, and a path both ends name is worth nothing if they
 * disagree about the VERBS. `aai-server`'s `GUEST_ROUTE_EXPOSURE` used to list
 * them from memory and this table twice grew one it did not have — see that
 * constant's doc for what each cost. Derived, so adding a route below is enough.
 *
 * @internal
 */
export const WORKFLOW_API_METHODS: readonly string[] = [
  ...new Set(ROUTES.map((r) => r.method)),
].sort();

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
  const { engine: resolveEngine, token, logger, uploads, directParts } = opts;

  async function route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): Promise<void> {
    // BEFORE the engine is resolved: resolving builds the runtime in the guest,
    // which is work an unauthenticated caller must not be able to trigger.
    if (workflowApiUnauthorized(req, res, token)) return;
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
      // The SAME sentence `ctx.workflows` rejects with: one condition, one
      // cause, one fix — see the option's doc.
      sendJson(res, 404, { error: WORKFLOWS_UNAVAILABLE_MESSAGE });
      return;
    }
    const matched = ROUTES.find((r) => r.method === method && r.matches(url));
    if (!matched) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    await matched.run(req, res, { engine, uploads, logger, directParts }, url);
  }

  return claimUnder<http.IncomingMessage, http.ServerResponse>({
    // The bare prefix IS a route here (it lists the declared workflows), unlike
    // `/session-events`, which is why `claimUnder` takes a predicate.
    claims: (url) => url === WORKFLOW_API_PREFIX || url.startsWith(`${WORKFLOW_API_PREFIX}/`),
    route,
    logger,
    label: "Workflow API request failed",
    // 413 rather than 400 or 500: the request was well-formed and too big, and
    // a caller has to tell "this input is too large" apart from "the agent is
    // broken". Mapped HERE rather than in the route that reads a body, so a
    // second body-reading route cannot forget it.
    onError: (err, res) => {
      if (res.headersSent) return false;
      const mapped = workflowApiErrorStatus(err);
      if (!mapped) return false;
      if (mapped.retryAfter) res.setHeader("Retry-After", mapped.retryAfter);
      sendJson(res, mapped.status, { error: mapped.error });
      return true;
    },
  });
}
