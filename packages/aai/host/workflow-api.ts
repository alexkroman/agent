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
 * GET  /workflows            → { workflows: [{ name, description? }] }
 * POST /workflows/runs       → { runId }              body: { workflow, input? }
 * GET  /workflows/runs/:id   → a WorkflowRunSnapshot
 * POST /workflows/blobs      → { blobId, bytes }      body: raw bytes
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

import { timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { errorMessage } from "../sdk/utils.ts";
import type { WorkflowClient, WorkflowSummary } from "../sdk/workflow.ts";
import type { Logger } from "./runtime-config.ts";

/** Path prefix every route here lives under. */
export const WORKFLOW_API_PREFIX = "/workflows";

/**
 * Env var holding the bearer this API requires. Unset leaves it open — see the
 * module doc.
 */
export const WORKFLOW_API_TOKEN_ENV = "AAI_WORKFLOW_API_TOKEN";

/**
 * Largest `POST /workflows/runs` body.
 *
 * Small on purpose: a run input is journaled, so anything big enough to matter
 * belongs in a blob. A generous cap here would quietly re-open the failure the
 * blob route exists to prevent.
 */
export const MAX_WORKFLOW_INPUT_BYTES = 64 * 1024;

/**
 * Largest single blob.
 *
 * Sized against what a caller can usefully do with one rather than against the
 * database: AssemblyAI's Sync API takes at most 120 s / 40 MB per request, and
 * 120 s of 16 kHz mono PCM is ~3.8 MB, so this clears the realistic chunk by
 * several times while keeping one request's peak memory bounded.
 */
export const MAX_WORKFLOW_BLOB_BYTES = 16 * 1024 * 1024;

/**
 * The engine slice this API needs — {@link WorkflowClient} (`start`/`get`, what
 * tool code sees as `ctx.workflows`) plus the two the HTTP surface adds.
 *
 * Spelled as an intersection rather than restated structurally. The restated
 * version was `WorkflowRunSnapshot` copied field for field with `status` widened
 * to `string` — so a seventh field or a sixth status had to be propagated here by
 * hand, and the widening guaranteed it would still compile if nobody did.
 */
export type WorkflowApiEngine = WorkflowClient & {
  putBlob(contentType: string, base64: string): Promise<string>;
  listing(): WorkflowSummary[];
};

export type WorkflowApiOptions = {
  /**
   * Resolve the engine, or undefined when the agent declared no workflows (or
   * storage is off) — in which case every route answers 404 rather than 500:
   * there is no workflow API on an app that has no workflows, and saying so is
   * more useful than reporting the engine's own unavailability message.
   *
   * A FUNCTION because the guest harness builds its runtime lazily, on the
   * first thing that needs it (see `lazyRuntime` in `aai-guest/harness.ts`) —
   * and for a static app the first such thing is a request to this API, not a
   * session. Resolved per request, so it must stay cheap: the harness's own
   * getter is memoized.
   */
  engine: () => WorkflowApiEngine | undefined;
  /**
   * Bearer required on every route. When undefined the API is OPEN — the
   * default, because a static page carries no credential (see the module doc).
   * Comes from {@link WORKFLOW_API_TOKEN_ENV} in the agent's env.
   */
  token?: string | undefined;
  logger: Logger;
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Constant-time bearer check.
 *
 * Length is compared first because `timingSafeEqual` THROWS on a length
 * mismatch rather than returning false — and comparing lengths leaks only the
 * length, which a caller supplied anyway.
 */
function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Read a request body, refusing anything past `limit`.
 *
 * Two decisions here, and both were arrived at by getting them wrong first.
 *
 * The size is counted **per chunk, never from `Content-Length`** — a client
 * controls that header independently of what it actually sends, so trusting it
 * means a lying header buffers the whole stream before anyone notices.
 *
 * And an over-limit body is **discarded as it arrives rather than answered by
 * destroying the socket**. What the cap has to bound is MEMORY, and dropping the
 * chunks does that completely; destroying the request additionally stops the
 * upload, which sounds strictly better and costs the thing that matters — the
 * client gets a socket error instead of the 413. For a page uploading a
 * recording in chunks that is the difference between "this file is too big" and
 * "something went wrong", so the bytes already in flight are allowed to arrive
 * and be thrown away. An endless upload is bounded by Node's own
 * `server.requestTimeout`.
 */
class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] | null = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Released here, not at `end`: holding a limit's worth of buffer for the
        // rest of a large upload is the allocation this is meant to prevent.
        chunks = null;
        return;
      }
      chunks?.push(chunk);
    });
    req.on("end", () => {
      if (chunks === null) reject(new BodyTooLargeError(limit));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

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
  const { workflow, input } = (parsed ?? {}) as { workflow?: unknown; input?: unknown };
  if (typeof workflow !== "string") {
    sendJson(res, 400, { error: 'Body must name a workflow: { "workflow": "<name>", input? }' });
    return;
  }
  // `start` rejects an unknown name and an input failing the workflow's own
  // schema, and both are the CALLER's mistake — so they are 400s carrying the
  // engine's message (which names the declared workflows, or the schema issues)
  // rather than 500s. Everything else is ours; the router's catch has it.
  let runId: string;
  try {
    runId = await engine.start(workflow, input);
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
  engine: WorkflowApiEngine,
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
  engine: WorkflowApiEngine,
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
  const { engine: resolveEngine, token, logger } = opts;
  const runsPrefix = `${WORKFLOW_API_PREFIX}/runs/`;

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
      engine: WorkflowApiEngine,
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
    {
      method: "GET",
      matches: (url) => url.startsWith(runsPrefix),
      run: (_req, res, engine, url) =>
        readRun(res, engine, decodeURIComponent(url.slice(runsPrefix.length))),
    },
    {
      method: "POST",
      matches: (url) => url === `${WORKFLOW_API_PREFIX}/blobs`,
      run: (req, res, engine) => putBlob(req, res, engine),
    },
  ];

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
    const engine = resolveEngine();
    if (!engine) {
      sendJson(res, 404, { error: "This app declares no workflows" });
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
