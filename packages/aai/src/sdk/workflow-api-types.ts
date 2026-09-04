// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow HTTP API's client-side TYPES: what a client is given, and what
 * it can be asked for.
 *
 * Split from `workflow-api-client.ts` because that file reached the 500-line
 * cap, and this is the seam that costs nothing: the call set is a description of
 * the routes, the module beside it is one `fetch` per description. The routes
 * themselves are `host/workflow-api.ts`, whose module doc is the authoritative
 * table, and the client's own module doc carries what a CALLER has to know
 * (a run outlives the request that started it; a failure carries the agent's
 * sentence). Neither is restated here.
 *
 * Nothing in here is a value, so this module is erased entirely at build time.
 */

import type { UploadInfo } from "./step-uploads.ts";
import type { WorkflowSummary } from "./workflow.ts";
import type { WakeUpOptions } from "./workflow-options.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";
import type { UploadBody, UploadOptions, UploadRef } from "./workflow-upload-client.ts";

/**
 * What a client needs to know: which agent, on whose authority, and for how
 * long.
 *
 * @public
 */
export type WorkflowApiClientOptions = {
  /**
   * The AGENT's base URL — `https://agents.example/my-agent`, with or without a
   * trailing slash. `WORKFLOW_API_PREFIX` is resolved under it, so a
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
   *
   * `| undefined` is explicit, and that is the whole point of it: under
   * `exactOptionalPropertyTypes` — which this repo and the scaffold both set —
   * `token?: string` REFUSES `token: process.env.AAI_WORKFLOW_API_TOKEN`, which
   * is the one line every caller writes. Absent and present-and-undefined mean
   * the same thing here (no bearer), so the type says so rather than making a
   * reader reach for a `!` or a conditional spread.
   */
  token?: string | undefined;
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
  timeoutMs?: number | undefined;
};

/**
 * The calls the API offers — one method per route, and nothing beyond them.
 *
 * The width is the constraint: a route needing more than a tool can do is the
 * signal to add a `WorkflowClient` method server-side, never to grow this
 * into an engine with reads of its own: this surface dispatches, it does not
 * query.
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
   * `stepReadUpload`.
   *
   * A `File` from an `<input type="file">` needs no second argument: its own
   * `name` and `type` are what get stored. Anything else — a `Blob`, a
   * `Uint8Array` — should name the file it is, since a step's failure messages
   * and the download link are all the name it will ever have.
   *
   * One request for the whole body, so a file past `MAX_WORKFLOW_UPLOAD_BYTES` is
   * a 413 rather than a truncation; {@link UploadOptions.onProgress} draws a bar.
   * `{ parallel: true }` sends it as concurrent parts instead, which is what a
   * recording over a long link wants — see {@link UploadOptions.parallel}.
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
   * Every snapshot of a run, until it settles — the call `watch` is the raw
   * material for.
   *
   * ```ts
   * import { createAgentClient } from "@alexkroman1/aai/workflow-api";
   *
   * const agent = createAgentClient({ baseUrl: "https://agents.example/my-agent" });
   * for await (const run of agent.follow("wrun_1")) console.log(run.status);
   * ```
   *
   * The last value is the TERMINAL snapshot, and reaching it is what ends the
   * iteration, so a caller that only wants the answer keeps the last one it saw.
   * The two protocol rules a hand-written loop gets wrong are honoured inside:
   * the stream hands the client back with an `idle` frame after its own duration
   * cap (a run may sleep for hours) and this re-opens, and a stream that ends
   * with the run unsettled THROWS rather than looking like a run that finished.
   *
   * There is no polling fallback, deliberately — an agent that does not serve
   * the route fails here with its own sentence, and a caller who wants to poll
   * instead is the caller {@link WorkflowApi.watch} exists for.
   */
  follow(runId: string, options?: { signal?: AbortSignal }): AsyncIterable<WorkflowRunSnapshot>;
  /**
   * Everything a run WRITES, in order, until it settles.
   *
   * ```ts
   * import { createAgentClient } from "@alexkroman1/aai/workflow-api";
   *
   * const agent = createAgentClient({ baseUrl: "https://agents.example/my-agent" });
   * for await (const chunk of agent.followOutput("wrun_1")) console.log(chunk);
   * ```
   *
   * One read of the route is bounded by the tail it saw, so this re-opens from
   * the next unread chunk until the run is finished — which is the rule that
   * makes a single `for await` cover a live run's whole log. Chunks are retained
   * with the run, so it is a replay as much as a tail and starts at the
   * beginning by default; `fromIndex` is ABSOLUTE, and the raw route's negative
   * "last N" form is left on {@link WorkflowApi.streamOutput} because it names
   * no position a re-open could resume from.
   */
  followOutput(
    runId: string,
    options?: { namespace?: string; fromIndex?: number; signal?: AbortSignal },
  ): AsyncIterable<unknown>;
  /**
   * End a run's `sleep()` early, resolving how many pending sleeps were
   * interrupted.
   *
   * `0` is an answer, not a failure — the run finished, was never sleeping, or is
   * gone. Same shape as {@link WorkflowApi.cancel} answering false, and for the
   * same reason: two tabs pressing "send it now" is ordinary.
   *
   * {@link WakeUpOptions.correlationIds} narrows it to the waits declared with
   * those ids, which is the same bag `ctx.workflows.wakeUp` takes and reaches the
   * route's repeatable `?correlationId=`. Reach for it when the caller means one
   * particular wait rather than "everything this run is waiting on" — and note it
   * is the ONLY spelling that can end a hook's approval deadline, since a bare
   * wake deliberately cannot (the journal filters a `hookTimeout` out of one).
   *
   * An id that is blank, or longer than 256 characters, REJECTS here without a
   * request being sent. The route answers 400 for both, and there is nothing a
   * caller can do with that answer that it could not do with a rejection it never
   * had to make a round trip for.
   */
  wake(runId: string, options?: WakeUpOptions): Promise<number>;
  /**
   * Store a file under an id YOU chose, so a run can start before it is all in.
   *
   * The counterpart of {@link WorkflowApi.upload}, and the difference is the order
   * it makes possible: `upload` answers with an id once the last byte is stored, so
   * a run that needs the id in its input has to wait for the whole upload. Here the
   * caller already has the id.
   *
   * `id` must be 1-64 characters of letters, digits, `-` and `_` (a
   * `crypto.randomUUID()` qualifies) and must not already exist — a second call on
   * one id is a 409, never an append.
   *
   * `{ parallel: true }` applies here too, and composes with the ORDER this method
   * exists for: the run reads the contiguous prefix as the parts fill it in,
   * exactly as it reads a single streaming `PUT`.
   */
  uploadStream(id: string, file: UploadBody, options?: UploadOptions): Promise<UploadRef>;
  /**
   * Read an upload's record: its name, how much has ARRIVED, and `complete`.
   *
   * What a page watches a streamed upload with. `complete` is the field to branch
   * on — a `size` that stopped growing means only that nothing arrived recently,
   * which a slow link and a dead client both produce.
   */
  uploadInfo(id: string): Promise<UploadInfo>;
  /**
   * Read an upload's BYTES, as a `Blob` — the other end of a run that PRODUCED
   * a file (`stepWriteUpload` stores it, the output carries the id). A `Blob`
   * rather than a URL because the byte route takes the same bearer every route
   * here does and neither `<audio src>` nor `<a href>` can send one;
   * `downloadUpload` carries the rest.
   */
  download(id: string, options?: { signal?: AbortSignal }): Promise<Blob>;
};
