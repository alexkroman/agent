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

import {
  apiRoot,
  apiFailure as failure,
  pendingRun,
  readApiJson as readJson,
} from "./_workflow-api-envelope.ts";
import { omitUndefined } from "./omit-undefined.ts";
import type { WorkflowSummary } from "./workflow.ts";
import { followRun, followRunOutput } from "./workflow-api-follow.ts";
import type { WorkflowApi, WorkflowApiClientOptions } from "./workflow-api-types.ts";
import type { WakeUpOptions } from "./workflow-options.ts";
import {
  clampWorkflowWait,
  MAX_WORKFLOW_WAIT_MS,
  type WorkflowRunSnapshot,
} from "./workflow-run.ts";
import {
  downloadUpload,
  readUploadInfo,
  streamUploadFile,
  type UploadBody,
  type UploadOptions,
  type UploadRef,
  uploadFile,
} from "./workflow-upload-client.ts";

// The prefix is declared beside the resolver that joins it and re-exported here,
// so every importer still reads it from the one public place.
export { WORKFLOW_API_PREFIX } from "./_workflow-api-envelope.ts";
// The record a caller reads back. Declared beside the STEP reader, because a body
// and a browser look at the same thing from two sides and a second shape for it is
// how the two would come to disagree about `complete`.
export type { UploadInfo, UploadRange } from "./step-uploads.ts";
// The call set and its options are declared in `workflow-api-types.ts` — see that
// module for why. They are re-exported here, so `@alexkroman1/aai/workflow-api`
// stays the one import path for the whole surface.
export type { WorkflowApi, WorkflowApiClientOptions } from "./workflow-api-types.ts";
// One import path for the whole surface. NAMED, not `type *` — that also
// re-exports `uploadFile`, putting an `@internal` name on a public subpath.
export type {
  UploadBody,
  UploadOptions,
  UploadParallelOption,
  UploadPartsOptions,
  UploadProgress,
  UploadRef,
} from "./workflow-upload-client.ts";

/**
 * Create a workflow API client.
 *
 * Hoist it out of anything that re-runs. In React it belongs at module scope —
 * `useWorkflowRun` in `@alexkroman1/aai-ui` holds the client in a ref
 * precisely so a fresh object
 * per render does not restart its watch, but a client built in render is still a
 * new `fetch` closure every time and reads as though it were free.
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
      // A `wait` is always answered with the snapshot, so the fallback covers only
      // a body that arrived without one — a proxy that rewrote it, or a replica
      // that has not yet seen its own write.
      return body.run ?? pendingRun(body.runId, workflow);
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

    // Generator delegation, not `async`: these resolve an ITERABLE, and the two
    // continuation rules the protocol needs live in `workflow-api-follow.ts`.
    follow(runId: string, options?: { signal?: AbortSignal }): AsyncIterable<WorkflowRunSnapshot> {
      return followRun(api, runId, options?.signal);
    },

    followOutput(
      runId: string,
      options?: { namespace?: string; fromIndex?: number; signal?: AbortSignal },
    ): AsyncIterable<unknown> {
      return followRunOutput(api, runId, options ?? {});
    },

    uploadStream: (id: string, file: UploadBody, options?: UploadOptions) =>
      streamUploadFile(base, auth, failure, id, file, options),

    uploadInfo: (id: string) => readUploadInfo(base, auth, failure, id),

    // No `deadline()`: like an upload, its duration is a function of the FILE.
    download: (id, options) => downloadUpload(base, auth, failure, id, options?.signal),

    async wake(runId: string, options?: WakeUpOptions): Promise<number> {
      const query = wakeQuery(options?.correlationIds);
      const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}/wake${query}`, {
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
 * Longest correlation id `POST /runs/:id/wake` accepts.
 *
 * The route's own `MAX_WORKFLOW_KEY_LENGTH` (`aai-runtime/workflow-api-runs.ts`),
 * restated rather than imported: this package may not import `aai-runtime`, and
 * publishing a bound the SERVER enforces onto `@alexkroman1/aai/workflow-api`
 * would put a route's implementation detail on the surface a CALLER is written
 * against — the split `workflow-api-barrel.ts`'s module doc argues at length.
 * What keeps the two honest is a test rather than a shared constant:
 * `workflow-api-runs.test.ts` drives this client against the real route at
 * exactly the boundary in both directions, in the one package that legitimately
 * depends on both halves.
 */
const MAX_WORKFLOW_KEY_LENGTH = 256;

/**
 * The `?correlationId=` query for a targeted wake, or `""` for a bare one.
 *
 * REFUSES what the route refuses, and refuses it before the request rather than
 * after. A blank id is a 400 there because the journal is explicit that an
 * empty-string correlation id is not the same as an absent one — two backends
 * used to fold them together and woke every uncorrelated sleep on the run — so a
 * caller that meant to send an id and computed nothing must not be served the
 * blunt wake by accident, and must not have to read a status code to learn it.
 *
 * An EMPTY list is a bare wake, deliberately: `correlationIds: []` is "no ids",
 * which is the absence, and encoding it as a query with nothing in it would send
 * the one shape the route reads as malformed.
 */
function wakeQuery(correlationIds: readonly string[] | undefined): string {
  if (!correlationIds || correlationIds.length === 0) return "";
  const params = new URLSearchParams();
  for (const id of correlationIds) {
    if (id.trim() === "") throw new Error("A workflow `correlationId` must not be empty");
    if (id.length > MAX_WORKFLOW_KEY_LENGTH) {
      throw new Error(
        `A workflow \`correlationId\` must be at most ${MAX_WORKFLOW_KEY_LENGTH} characters`,
      );
    }
    params.append("correlationId", id);
  }
  return `?${params.toString()}`;
}
