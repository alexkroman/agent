// Copyright 2026 the AAI authors. MIT license.
/**
 * A client for the workflow HTTP API — one method per route, one request per
 * call, and no framework.
 *
 * The API itself is `host/workflow-api.ts`, whose module doc is the
 * authoritative route table. This is the other end of it, and it is HERE rather
 * than in whichever package needed it first because by the time it was written
 * down it had been written THREE times — the browser client
 * (`aai-ui/workflow-client.ts`), the studio's Workflows card
 * (`aai-studio-client/src/workflows-card.tsx`), and `aai workflow`
 * (`aai-cli/workflow.ts`) — with the doc example on
 * {@link responseErrorMessage} standing in for a fourth, because what every
 * caller reached for first was the three lines at the top of one of these.
 *
 * Each copy was a SUBSET, each subset was a different one, and the parts they
 * disagreed on were exactly the parts a reader cannot check by eye: whether a
 * 404 is an answer or a failure, whether `limit` is encoded when absent, whether
 * a `{ runs }` envelope that arrived without the field reads as empty or as a
 * crash, and whether the agent's own `{ error }` sentence is unwrapped or
 * reported still wrapped in its JSON (the studio's did the latter for a while,
 * which is the whole diagnostic arriving unreadable).
 *
 * It lives in `sdk/` (no `node:` imports, `fetch` and `URL` only), so the same
 * module serves a browser page, the CLI, and a user's own script.
 *
 * ## What a caller has to know
 *
 * **A run outlives the request that started it, and that is the whole shape of
 * this surface.** {@link WorkflowApi.start} resolves as soon as the run is
 * created, so `runId` is the only handle that matters and it stays valid across
 * a reload, a different device, or `curl`. Everything else here either reads
 * that handle back or steers it.
 *
 * **A failure carries the AGENT'S sentence, never a status code.** Every route
 * answers `{ error }` and that text is the whole diagnostic — an unknown
 * workflow names the ones that are declared, a rejected input names the schema
 * issues, a 404 from an agent with no workflow API names both of ITS causes. A
 * body that is not that shape (a proxy, a CDN, a platform broker answering while
 * a sandbox boots) degrades to the status with a short preview, which is
 * {@link responseErrorMessage}'s job and not restated here.
 *
 * **Nothing here brokers.** Every URL is built from the `baseUrl` it was given,
 * once, at construction. That is deliberate for the deployed case: a platform
 * tunnel URL changes on every respawn while a page holding a `runId` does not,
 * so the address a caller uses has to be the stable public one and the platform
 * forwards it (`aai-server/workflow-handler.ts`).
 *
 * @example
 * ```ts
 * import { createWorkflowApiClient } from "@alexkroman1/aai/workflow-api";
 *
 * const api = createWorkflowApiClient({ baseUrl: "https://agents.example/my-agent" });
 * const run = await api.startAndWait("digest", { topic: "ai" });
 * if (run.status === "completed") console.log(run.output);
 * ```
 */

import { omitUndefined } from "./omit-undefined.ts";
import { readJsonBody } from "./response-body.ts";
import { responseErrorMessage } from "./utils.ts";
import type { WorkflowSummary } from "./workflow.ts";
import {
  clampWorkflowWait,
  MAX_WORKFLOW_WAIT_MS,
  type WorkflowRunSnapshot,
} from "./workflow-run.ts";
import {
  type UploadBody,
  type UploadOptions,
  type UploadRef,
  uploadFile,
} from "./workflow-upload-client.ts";

/**
 * Path prefix every route lives under, relative to the agent's own base URL.
 *
 * Defined on this side and re-exported by `host/workflow-api.ts` (and so by
 * `@alexkroman1/aai/runtime`, which is where the server and the `aai dev` proxy
 * table read it from). One literal for both ends: a client asking for a path the
 * server does not serve is a 404 that reads as a missing feature, and the dev
 * proxy getting it wrong is a workflow app that is dead on arrival under
 * `aai dev` while the backend serves the whole API one port over. It could not
 * live in `host/` and be shared, because a browser cannot import that half.
 *
 * @public
 */
export const WORKFLOW_API_PREFIX = "/workflows";

/**
 * Label put in front of a status when the answer was NOT this API's `{ error }`
 * shape — see {@link responseErrorMessage}, which prefixes nothing when the
 * agent gave its own sentence. It names the surface that answered, which is the
 * one thing a bare `502: <html>` does not say.
 */
const ERROR_LABEL = "Workflow API";

/**
 * What a client needs to know: which agent, on whose authority, and for how
 * long.
 *
 * @public
 */
export type WorkflowApiClientOptions = {
  /**
   * The AGENT's base URL — `https://agents.example/my-agent`, with or without a
   * trailing slash. {@link WORKFLOW_API_PREFIX} is resolved under it, so a
   * caller never spells the prefix and the three call sites that used to
   * concatenate it cannot drift.
   *
   * Required, and deliberately: `location` does not exist in this half of the
   * SDK, so "the page's own origin" is a browser default and belongs with the
   * browser client (`createWorkflowApi` in `@alexkroman1/aai-ui`).
   */
  baseUrl: string;
  /**
   * Bearer for an agent whose operator set `AAI_WORKFLOW_API_TOKEN`.
   *
   * A page served to the public has nothing to put here and should not — it
   * would be readable in the bundle. This is for a programmatic caller: a
   * script, a cron job, `aai workflow --token`.
   */
  token?: string;
  /**
   * Per-request deadline, in ms. Absent means none, which is what a page with
   * its own retry loop wants.
   *
   * Worth setting for anything a human is waiting on, because **a hung request
   * is not a failure**: `fetch` carries no timeout of its own, so a request
   * issued while the platform is restarting or saturated never settles and no
   * error path, retry, or backoff ever runs. The one thing it must not bound is
   * the event stream — a healthy SSE connection IS a request that stays open and
   * says nothing for minutes — so {@link WorkflowApi.watch} is exempt, and the
   * two waiting paths get the run's own `wait` budget added on top rather than
   * being cut in the middle of a wait the agent agreed to.
   */
  timeoutMs?: number;
};

/**
 * The calls the API offers — one method per route, and nothing beyond them.
 *
 * The width is the constraint: a route needing more than a tool can do is the
 * signal to add a `WorkflowClient` method server-side, never to grow this into
 * an engine with reads of its own. See the "no engine here" section of
 * `host/workflow-api.ts`.
 *
 * @public
 */
export type WorkflowApi = {
  /** Declared workflows: name, description, and the input schema to render. */
  list(): Promise<WorkflowSummary[]>;
  /**
   * Store a file and resolve the handle a run input carries.
   *
   * The other half of `WorkflowDef.uploads`: a workflow's input is journaled and
   * replayed on every resume, so bytes may not travel in it — they go here once,
   * and the run carries {@link UploadRef.id}, which a step reads windows of with
   * `readUpload`.
   *
   * A `File` from an `<input type="file">` needs no second argument: its own
   * `name` and `type` are what get stored. Anything else — a `Blob`, a
   * `Uint8Array` — should name the file it is, since a step's failure messages
   * and the download link are all the name it will ever have.
   *
   * The whole body is sent in one request, so a file past
   * `MAX_WORKFLOW_UPLOAD_BYTES` is refused with a 413 rather than truncated.
   */
  upload(file: UploadBody, options?: UploadOptions): Promise<UploadRef>;
  /**
   * Start a run and resolve its id WITHOUT waiting for it — the point of the
   * mechanism. Rejects when the name is not declared or the input fails the
   * workflow's schema, both of which are 400s carrying the reason.
   *
   * `key` is a correlation handle the caller chooses, so the run can be found
   * again later without the id — a signed-in user, an upload, a device. Pass one
   * when the caller might be gone before the run finishes and you would rather
   * look it up than remember the id.
   */
  start(workflow: string, input?: unknown, options?: { key?: string }): Promise<string>;
  /**
   * Start a run and resolve the FINISHED one — the synchronous call.
   *
   * What a form or a shell script wants, and what {@link WorkflowApi.start}
   * deliberately is not: one request in, one result out, with no watch to wire
   * up. The agent holds the request open until the run settles or its own budget
   * expires, so a run that is still going when the wait runs out resolves
   * NON-terminal — check `isTerminal`, or keep the id and read it back later.
   *
   * `wait` is clamped to `MAX_WORKFLOW_WAIT_MS` at both ends, by the same
   * function, so this can never be waiting on a request the agent already
   * answered.
   */
  startAndWait(
    workflow: string,
    input?: unknown,
    options?: { key?: string; wait?: number },
  ): Promise<WorkflowRunSnapshot>;
  /**
   * Read a run's state. Resolves undefined for an unknown id.
   *
   * Deliberately NOT generic on the output, even though a caller wants it typed:
   * a generic METHOD has to be implemented generically, which would make every
   * test double and every hand-written stub of this client generic too. The type
   * parameter belongs on whatever a caller states its expectation with —
   * `useWorkflowRun<R>` in the browser client, or a cast at the one place a
   * script reads `output`.
   */
  get(runId: string, options?: { wait?: number }): Promise<WorkflowRunSnapshot | undefined>;
  /** Runs of `workflow` started with `key`, newest first. */
  find(workflow: string, key: string, options?: { limit?: number }): Promise<WorkflowRunSnapshot[]>;
  /**
   * Runs of `workflow`, newest first, whatever key they carry.
   *
   * The operator's read where {@link WorkflowApi.find} is the app's — a console
   * has no correlation key to ask about, and most runs carry none (a page holds
   * its own `runId`). Two methods rather than one nullable key, so a caller
   * meaning "this user's runs" cannot silently widen to every user's.
   */
  recent(workflow: string, options?: { limit?: number }): Promise<WorkflowRunSnapshot[]>;
  /**
   * Stop a run, resolving whether this call is what ended it. A run that had
   * already finished answers false rather than failing — two tabs pressing Stop
   * is ordinary.
   */
  cancel(runId: string): Promise<boolean>;
  /**
   * Open a server-sent-event stream of one run's state.
   *
   * Resolves the raw `Response` rather than parsed frames, because what a caller
   * needs to decide first is whether the agent SERVES this at all — an older
   * deploy answers 404 and the caller falls back to polling, which is a normal
   * path rather than an error.
   */
  watch(runId: string, signal?: AbortSignal): Promise<Response>;
  /**
   * Open a server-sent-event stream of what the run has WRITTEN — its progress,
   * as opposed to {@link WorkflowApi.watch}'s status transitions.
   *
   * Resolves the raw `Response` for the same reason `watch` does: an agent
   * deployed before this route existed answers 404, which a caller has to be able
   * to see rather than have raised at it. Frames are `chunk` then `done`.
   *
   * Chunks are retained with the run, so this is a replay as much as a live tail:
   * a caller that reloads gets the whole stream by default, and `startIndex`
   * (negative counts back from the end) is for a reader resuming from a known
   * position.
   */
  streamOutput(
    runId: string,
    options?: { namespace?: string; startIndex?: number; signal?: AbortSignal },
  ): Promise<Response>;
  /**
   * End a run's `sleep()` early, resolving how many pending sleeps were
   * interrupted.
   *
   * `0` is an answer, not a failure — the run finished, was never sleeping, or is
   * gone. Same shape as {@link WorkflowApi.cancel} answering false, and for the
   * same reason: two tabs pressing "send it now" is ordinary.
   */
  wake(runId: string): Promise<number>;
};

/**
 * Resolve the API root under an agent's base URL.
 *
 * ONE resolver rather than a trailing-slash rule per call site — two of those is
 * how the browser session's endpoints and this one drifted. The prefix is
 * stripped of its leading `/` before it is joined, because `new URL("/x", base)`
 * is ABSOLUTE and would drop the agent's own path segment, turning every request
 * for a deployed agent into a request for the platform root.
 */
function apiRoot(baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(WORKFLOW_API_PREFIX.replace(/^\//, ""), base).toString();
}

/** Read the agent's error sentence out of a failed response. */
async function failure(res: Response): Promise<Error> {
  return new Error(await responseErrorMessage(res, ERROR_LABEL));
}

/**
 * A successful body, parsed — labelled, because the status does NOT decide
 * whether a body is JSON. Every route here answered `res.json()` unguarded, so
 * a proxy's `200 text/html` rejected with a bare `SyntaxError` carrying no
 * status and no `runId`. See {@link readJsonBody}.
 */
function readJson<T>(res: Response): Promise<T> {
  return readJsonBody<T>(res, ERROR_LABEL);
}

// Re-exported so `@alexkroman1/aai/workflow-api` stays the one import path for
// everything this surface takes and returns.
export type { UploadBody, UploadOptions, UploadRef } from "./workflow-upload-client.ts";

/**
 * Create a workflow API client.
 *
 * Hoist it out of anything that re-runs. In React it belongs at module scope —
 * `useWorkflowRun` holds the client in a ref precisely so a fresh object per
 * render does not restart its watch, but a client built in render is still a new
 * `fetch` closure every time and reads as though it were free.
 *
 * @public
 */
export function createWorkflowApiClient(opts: WorkflowApiClientOptions): WorkflowApi {
  const base = apiRoot(opts.baseUrl);
  const auth: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};

  /**
   * The per-request deadline, or nothing.
   *
   * `extraMs` is the wait budget the agent has agreed to hold the socket open
   * for; without it a 20s client deadline would cut a 60s wait in the middle and
   * report a network error for a run that is perfectly healthy — losing the one
   * thing the caller cannot rebuild.
   */
  function deadline(extraMs = 0): { signal?: AbortSignal } {
    if (opts.timeoutMs === undefined) return {};
    return { signal: AbortSignal.timeout(opts.timeoutMs + extraMs) };
  }

  /** `POST /runs`, shared by `start` and `startAndWait`. */
  async function postRun(
    workflow: string,
    input: unknown,
    options: { key?: string | undefined; wait?: number | undefined },
  ): Promise<{ runId: string; run?: WorkflowRunSnapshot }> {
    const wait = options.wait;
    const res = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ workflow, ...omitUndefined({ input, key: options.key, wait }) }),
      ...deadline(wait),
    });
    if (!res.ok) throw await failure(res);
    return await readJson<{ runId: string; run?: WorkflowRunSnapshot }>(res);
  }

  /**
   * `GET /runs` — shared by `find` and `recent`, which differ only in whether
   * the query carries a `key`.
   *
   * One reader so the two cannot drift on the parts that are not the difference:
   * the limit's encoding, the `{ runs }` envelope, and the empty-array fallback
   * for a body that answered without one.
   */
  async function listRuns(
    query: Record<string, string>,
    limit: number | undefined,
  ): Promise<WorkflowRunSnapshot[]> {
    const params = new URLSearchParams(query);
    if (limit !== undefined) params.set("limit", String(limit));
    const res = await fetch(`${base}/runs?${params.toString()}`, {
      headers: auth,
      ...deadline(),
    });
    if (!res.ok) throw await failure(res);
    const body = await readJson<{ runs?: WorkflowRunSnapshot[] }>(res);
    return body.runs ?? [];
  }

  const api: WorkflowApi = {
    upload(file: UploadBody, options?: UploadOptions): Promise<UploadRef> {
      return uploadFile(base, auth, failure, file, options);
    },

    async list(): Promise<WorkflowSummary[]> {
      const res = await fetch(base, { headers: auth, ...deadline() });
      if (!res.ok) throw await failure(res);
      const body = await readJson<{ workflows?: WorkflowSummary[] }>(res);
      return body.workflows ?? [];
    },

    async start(workflow: string, input?: unknown, options?: { key?: string }): Promise<string> {
      const { runId } = await postRun(workflow, input, { key: options?.key });
      return runId;
    },

    async startAndWait(
      workflow: string,
      input?: unknown,
      options?: { key?: string; wait?: number },
    ): Promise<WorkflowRunSnapshot> {
      const wait = clampWorkflowWait(options?.wait ?? MAX_WORKFLOW_WAIT_MS);
      const body = await postRun(workflow, input, { key: options?.key, wait });
      // An agent too old to understand `wait` answers `{ runId }` and nothing
      // else. Reading the run back once is what turns that into the same shape
      // rather than an `undefined` the caller has to branch on — it is one extra
      // request against a deploy that predates this, not a fallback path anyone
      // stays on.
      return body.run ?? (await api.get(body.runId, { wait })) ?? pendingRun(body.runId, workflow);
    },

    async get(
      runId: string,
      options?: { wait?: number },
    ): Promise<WorkflowRunSnapshot | undefined> {
      const wait = clampWorkflowWait(options?.wait);
      const query = wait > 0 ? `?wait=${wait}` : "";
      const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}${query}`, {
        headers: auth,
        ...deadline(wait),
      });
      // 404 is "no such run", which is an ANSWER rather than a failure: a caller
      // reading an id it just started can legitimately race the run's creation.
      // Note the status is also what an agent with no workflow API at all
      // answers, so a caller that needs to tell those apart has to say so in its
      // own words — there is no second signal here to read.
      if (res.status === 404) return;
      if (!res.ok) throw await failure(res);
      return await readJson<WorkflowRunSnapshot>(res);
    },

    find(
      workflow: string,
      key: string,
      options?: { limit?: number },
    ): Promise<WorkflowRunSnapshot[]> {
      return listRuns({ workflow, key }, options?.limit);
    },

    recent(workflow: string, options?: { limit?: number }): Promise<WorkflowRunSnapshot[]> {
      // No `key` in the query is what selects the keyless read server-side.
      return listRuns({ workflow }, options?.limit);
    },

    watch(runId: string, signal?: AbortSignal): Promise<Response> {
      // No `deadline()` here, and that is the point of the exemption: a healthy
      // stream stays open indefinitely, so no duration separates it from a hung
      // one. Its liveness comes from the other end — the route pings, and a dead
      // connection surfaces as the read ending.
      return fetch(`${base}/runs/${encodeURIComponent(runId)}/events`, {
        headers: { ...auth, Accept: "text/event-stream" },
        ...omitUndefined({ signal }),
      });
    },

    streamOutput(
      runId: string,
      options?: { namespace?: string; startIndex?: number; signal?: AbortSignal },
    ): Promise<Response> {
      // Exempt from `deadline()` for the same reason `watch` is — this one is a
      // long tail of a run's own output, so it is if anything longer-lived.
      const params = new URLSearchParams(
        omitUndefined({
          namespace: options?.namespace,
          startIndex: options?.startIndex === undefined ? undefined : String(options.startIndex),
        }),
      );
      const query = params.size > 0 ? `?${params.toString()}` : "";
      return fetch(`${base}/runs/${encodeURIComponent(runId)}/stream${query}`, {
        headers: { ...auth, Accept: "text/event-stream" },
        ...omitUndefined({ signal: options?.signal }),
      });
    },

    async wake(runId: string): Promise<number> {
      const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}/wake`, {
        method: "POST",
        headers: auth,
        ...deadline(),
      });
      // A run the agent does not know is "nothing was sleeping", which is the
      // same answer as a live run that was not asleep — see `wake`'s doc.
      if (res.status === 404) return 0;
      if (!res.ok) throw await failure(res);
      const body = await readJson<{ woken?: number }>(res);
      return body.woken ?? 0;
    },

    async cancel(runId: string): Promise<boolean> {
      const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}`, {
        method: "DELETE",
        headers: auth,
        ...deadline(),
      });
      if (!res.ok) throw await failure(res);
      const body = await readJson<{ cancelled?: boolean }>(res);
      return body.cancelled === true;
    },
  };

  return api;
}

/**
 * The snapshot a `startAndWait` falls back to when the run exists and cannot be
 * read back.
 *
 * Reachable only against an agent that answered `{ runId }` and then reported no
 * such run — a replica that has not yet seen its own write. Saying `pending` is
 * both true and useful: the caller has the id, and reading it again takes it
 * from there.
 */
function pendingRun(runId: string, workflow: string): WorkflowRunSnapshot {
  return { runId, workflow, createdAt: Date.now(), status: "pending" };
}
