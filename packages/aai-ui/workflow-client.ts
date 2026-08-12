// Copyright 2026 the AAI authors. MIT license.
/**
 * Browser client for the workflow HTTP API (`host/workflow-api.ts`).
 *
 * This is the whole client half of a STATIC page: an app whose front door is a
 * form rather than a microphone starts runs here, uploads whatever bytes they
 * work on, and polls for the answer. It deliberately does NOT go through
 * `SessionCore` — there is no socket, no audio graph, and no session to resume.
 *
 * The one thing worth knowing before using it: a run outlives the page. Starting
 * one resolves as soon as it is journaled, so `runId` is the only handle that
 * matters and it stays valid across a reload, a different device, or `curl` —
 * which is what makes {@link useWorkflowRun} a poll rather than a subscription.
 */

import { isTerminal, type WorkflowRunSnapshot, type WorkflowSummary } from "@alexkroman1/aai";
import { useEffect, useRef, useState } from "react";
import { pageBaseUrl } from "./_utils.ts";
import { buildAgentUrl } from "./client-config.ts";
import { watchRunEvents } from "./workflow-events.ts";

/**
 * A run's observable state, and one declared workflow.
 *
 * Aliased from the SDK rather than restated. The earlier copies were justified as
 * keeping the host SDK's graph out of the browser bundle, which is wrong twice
 * over: `import type` is erased entirely, and this package already *value*-imports
 * from `@alexkroman1/aai` in five modules. What they really cost was a second
 * definition of seven fields and a five-member status union with nothing
 * asserting they agree — so a status added to the SDK would never reach the
 * browser type.
 *
 * `WorkflowRun` keeps the shorter name because it is what a page's own code
 * writes; nothing in a browser needs the word "snapshot" to know a poll returns
 * one.
 *
 * It is GENERIC on the run's output, and a page supplies it — see
 * {@link useWorkflowRun}. It does NOT have to restate it: `import type` is erased,
 * so a page can name the workflow itself and derive the rest with
 * {@link WorkflowOutputOf}, pulling no server graph into the bundle. This comment
 * used to say the opposite, on the same wrong premise the `WorkflowRunSnapshot`
 * copies above were justified by.
 */
export type WorkflowRun<R = unknown> = WorkflowRunSnapshot<R>;
/**
 * A workflow's own output type — re-exported so a page needs ONE import to type
 * its runs. See the SDK's own doc: a type-only import of `agent.ts` is erased, so
 * deriving the type costs the browser bundle nothing.
 */
export type { WorkflowOutputOf, WorkflowSummary } from "@alexkroman1/aai";

/**
 * A run status nothing will change again.
 *
 * Re-exported from the SDK rather than defined here. It was a second
 * implementation listing two of the terminal statuses, so adding `cancelled`
 * would have left a cancelled run polled forever by a page while the agent
 * considered it finished — the kind of drift a status predicate beside the status
 * union cannot have.
 */
export { isTerminal } from "@alexkroman1/aai";

export type WorkflowApiOptions = {
  /**
   * Base URL of the agent. Defaults to the page's own origin + path, which is
   * right for a page the agent itself serves — the only case that exists today.
   */
  baseUrl?: string;
  /**
   * Bearer for an agent whose operator set `AAI_WORKFLOW_API_TOKEN`. A page
   * served to the public has nothing to put here (and should not — it would be
   * readable in the bundle); this exists for a programmatic caller written
   * against the same client.
   */
  token?: string;
};

/** The calls the API offers. */
export type WorkflowApi = {
  /** Declared workflows, name + description. */
  list(): Promise<WorkflowSummary[]>;
  /**
   * Start a run and resolve its id WITHOUT waiting for it — the point of the
   * mechanism. Rejects when the name is not declared or the input fails the
   * workflow's schema, both of which are 400s carrying the reason.
   *
   * `key` is a correlation handle the page chooses, so the run can be found again
   * later without the id — a signed-in user, an upload, a device. Pass one when
   * the page might be reloaded before the run finishes and you would rather look
   * it up than remember the id.
   */
  start(workflow: string, input?: unknown, options?: { key?: string }): Promise<string>;
  /**
   * Read a run's state. Resolves undefined for an unknown id.
   *
   * Deliberately NOT generic on the output, even though a page wants it typed:
   * a generic METHOD has to be implemented generically, which made every test
   * double and every hand-written stub of this client generic too. The type
   * parameter lives on {@link useWorkflowRun} instead, which is where a page
   * states what it expects anyway.
   */
  get(runId: string): Promise<WorkflowRun | undefined>;
  /** Runs of `workflow` started with `key`, newest first. */
  find(workflow: string, key: string, options?: { limit?: number }): Promise<WorkflowRun[]>;
  /**
   * Runs of `workflow`, newest first, whatever key they carry.
   *
   * The operator's read where {@link find} is the agent's — a console has no
   * correlation key to ask about, and most runs carry none (a page holds its own
   * `runId`). Two methods rather than one nullable key, so a caller meaning "this
   * session's runs" cannot silently widen to every session's.
   */
  recent(workflow: string, options?: { limit?: number }): Promise<WorkflowRun[]>;
  /**
   * Stop a run, resolving whether this call is what ended it. A run that had
   * already finished answers false rather than failing — two tabs pressing Stop
   * is ordinary.
   */
  cancel(runId: string): Promise<boolean>;
  /**
   * Send a failed or cancelled run back to the queue, resolving whether this call
   * revived it. A run that is still live answers false rather than failing.
   *
   * The journal is kept, so it resumes from its last completed step rather than
   * starting over.
   */
  retry(runId: string): Promise<boolean>;
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
   * Upload bytes for a run to work on, resolving the id that names them.
   *
   * Needed because a run's input is JOURNALED and replayed on every resume, so
   * bytes may not travel in it — see `WorkflowStore.putBlob`. Pass the id in the
   * run input instead; the workflow reads the blob from its own database.
   */
  upload(
    bytes: Uint8Array<ArrayBuffer> | ArrayBuffer | Blob | string,
    contentType?: string,
  ): Promise<{ blobId: string; bytes: number }>;
};

/**
 * Read the server's error sentence out of a failed response.
 *
 * Every route here answers `{ error }`, and that text is the whole diagnostic —
 * an unknown workflow names the declared ones, a bad input names the schema
 * issues. A body that is not that shape degrades to the status, which is what a
 * proxy or a gateway in front of the agent would produce.
 */
async function failure(res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return new Error(parsed.error);
  } catch {
    /* not JSON — fall through to the status */
  }
  return new Error(`Workflow API ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
}

/**
 * Create a workflow API client.
 *
 * @public
 */
export function createWorkflowApi(opts: WorkflowApiOptions = {}): WorkflowApi {
  // `buildAgentUrl` is this package's own resolver for "a path under the agent's
  // base URL" — the same one the session's endpoints go through. A second
  // trailing-slash rule over the same `pageBaseUrl()` value is how the two drift.
  const base = buildAgentUrl(opts.baseUrl ?? pageBaseUrl(), "workflows").toString();
  const auth: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};

  /**
   * `GET /runs` — shared by `find` and `recent`, which differ only in whether the
   * query carries a `key`.
   *
   * One reader so the two cannot drift on the parts that are not the difference:
   * the limit's encoding, the `{ runs }` envelope, and the empty-array fallback
   * for a body that answered without one.
   */
  async function listRuns(
    query: Record<string, string>,
    limit: number | undefined,
  ): Promise<WorkflowRun[]> {
    const params = new URLSearchParams(query);
    if (limit !== undefined) params.set("limit", String(limit));
    const res = await fetch(`${base}/runs?${params.toString()}`, { headers: auth });
    if (!res.ok) throw await failure(res);
    const body = (await res.json()) as { runs?: WorkflowRun[] };
    return body.runs ?? [];
  }

  return {
    async list(): Promise<WorkflowSummary[]> {
      const res = await fetch(base, { headers: auth });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { workflows?: WorkflowSummary[] };
      return body.workflows ?? [];
    },

    async start(workflow: string, input?: unknown, options?: { key?: string }): Promise<string> {
      const res = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          ...(input === undefined ? {} : { input }),
          ...(options?.key === undefined ? {} : { key: options.key }),
        }),
      });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { runId: string };
      return body.runId;
    },

    async get(runId: string): Promise<WorkflowRun | undefined> {
      const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}`, { headers: auth });
      // 404 is "no such run", which is an ANSWER rather than a failure: a page
      // polling an id it just started can legitimately race the journal write.
      if (res.status === 404) return;
      if (!res.ok) throw await failure(res);
      return (await res.json()) as WorkflowRun;
    },

    async find(
      workflow: string,
      key: string,
      options?: { limit?: number },
    ): Promise<WorkflowRun[]> {
      return await listRuns({ workflow, key }, options?.limit);
    },

    async recent(workflow: string, options?: { limit?: number }): Promise<WorkflowRun[]> {
      // No `key` in the query is what selects the keyless read server-side.
      return await listRuns({ workflow }, options?.limit);
    },

    watch(runId: string, signal?: AbortSignal): Promise<Response> {
      return fetch(`${base}/runs/${encodeURIComponent(runId)}/events`, {
        headers: { ...auth, Accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      });
    },

    async retry(runId: string): Promise<boolean> {
      const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}/retry`, {
        method: "POST",
        headers: auth,
      });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { retried?: boolean };
      return body.retried === true;
    },

    async cancel(runId: string): Promise<boolean> {
      const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}`, {
        method: "DELETE",
        headers: auth,
      });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { cancelled?: boolean };
      return body.cancelled === true;
    },

    async upload(
      bytes: Uint8Array<ArrayBuffer> | ArrayBuffer | Blob | string,
      contentType = "application/octet-stream",
    ): Promise<{ blobId: string; bytes: number }> {
      const res = await fetch(`${base}/blobs`, {
        method: "POST",
        headers: { ...auth, "Content-Type": contentType },
        // Sent as-is: every accepted type is already a valid `BodyInit` and the
        // header is set above, so wrapping it in a `Blob` bought nothing and
        // copied the whole payload — ~2 MB per chunk in the transcription page.
        body: bytes,
      });
      if (!res.ok) throw await failure(res);
      return (await res.json()) as { blobId: string; bytes: number };
    },
  };
}

/** How often {@link useWorkflowRun} re-reads a live run. */
export const DEFAULT_WORKFLOW_POLL_MS = 2000;

/**
 * Consecutive "no such run" reads {@link useWorkflowRun} tolerates before giving
 * up on the id.
 *
 * Small on purpose: a 404 is a stable answer, so the budget exists only to
 * absorb a first read that races the write — not to keep hoping. Unbounded, a
 * stale id polls (and, on the platform, BROKERS) for as long as the tab is open.
 */
export const MAX_MISSING_READS = 3;

export type UseWorkflowRunResult<R = unknown> = {
  /** Latest snapshot, or undefined before the first read lands. */
  run: WorkflowRun<R> | undefined;
  /** The last read's failure, cleared by the next successful one. */
  error: string | undefined;
  /** True while a non-terminal run is still being polled. */
  polling: boolean;
};

/**
 * Poll `runId` until it is terminal, reporting each read. Returns a stop
 * function.
 *
 * Module-level rather than inline in the hook below, so neither function carries
 * the whole loop's branching — and so the loop can be read (and reasoned about)
 * without React in the way.
 */
function pollUntilTerminal<R>(
  getClient: () => WorkflowApi,
  runId: string,
  intervalMs: number,
  onRun: (run: WorkflowRun<R>) => void,
  onError: (message: string) => void,
  onStopped: () => void,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let missing = 0;

  /**
   * A read that came back empty. Resolves whether the loop should STOP.
   *
   * A 404 is a STABLE answer — the journal is durable, so a run the agent does not
   * know about now will not appear later — and retrying it unbounded is how a
   * stale id (one restored from `localStorage`, or one whose agent was redeployed
   * onto a fresh database) polls forever: the page stays `polling` and therefore
   * busy, and on the platform every read BROKERS, so a closed tab's worth of dead
   * ids keeps sandboxes resident. A small budget is kept anyway, because the first
   * read can race a replica that has not yet seen the run.
   */
  const onMissing = (): boolean => {
    missing += 1;
    if (missing < MAX_MISSING_READS) return false;
    if (!cancelled) onError(`No workflow run ${runId}`);
    return true;
  };

  const read = async (): Promise<boolean> => {
    try {
      // Resolved per read rather than captured once, so a caller that swaps
      // clients mid-run — a token arriving after login — is picked up on the
      // next poll without the loop restarting. See the ref in the hook.
      // The generic is the PAGE's assertion about its own agent's workflow, which
      // nothing in the browser can verify — the client reads JSON off a route that
      // describes no output type. Narrowed once, here, rather than at every call
      // site reading `run.output`.
      const next = (await getClient().get(runId)) as WorkflowRun<R> | undefined;
      if (cancelled) return true;
      if (!next) return onMissing();
      missing = 0;
      onRun(next);
      // Terminal: nothing will change again, so stop rather than poll a
      // finished run for as long as the page stays open.
      return isTerminal(next);
    } catch (err) {
      // Reported and RETRIED: a dropped request against a booting sandbox is the
      // common case here, and giving up would strand a live run.
      if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const tick = async (): Promise<void> => {
    if (await read()) {
      // Stopped on its own — a terminal run, or an id the agent will never know.
      // Reported because `polling` cannot be derived from the snapshot alone:
      // giving up on a MISSING id leaves `run` undefined, which reads as "still
      // waiting" and left the page permanently busy.
      if (!cancelled) onStopped();
      return;
    }
    if (cancelled) return;
    // Re-armed from the SETTLED read rather than on an interval, so a slow
    // response cannot stack overlapping polls.
    timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();

  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/**
 * Poll one run until it reaches a terminal status.
 *
 * A poll rather than a subscription because a run is durable and the page is
 * not: it can complete while the tab is closed, on a different sandbox, hours
 * later. There is no socket to push down and nothing to reconnect — the id is
 * the whole state, so re-reading it is both the simplest and the most honest
 * implementation.
 *
 * Polling STOPS on a terminal status, so a finished run costs nothing; passing
 * `undefined` (nothing started yet) also costs nothing.
 *
 * @typeParam R - The workflow's output type. Supplying it is what makes
 *   `run.status === "completed"` narrow to a typed `run.output` instead of
 *   `unknown` — the page has to name it because it cannot import the workflow
 *   itself (see {@link WorkflowRun}).
 *
 * @public
 */
export function useWorkflowRun<R = unknown>(
  runId: string | undefined,
  opts: { api?: WorkflowApi; intervalMs?: number } = {},
): UseWorkflowRunResult<R> {
  const { api, intervalMs = DEFAULT_WORKFLOW_POLL_MS } = opts;
  const [run, setRun] = useState<WorkflowRun<R> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  /**
   * Has the loop stopped for a reason the snapshot does not show?
   *
   * Only one such reason exists — an id the agent kept reporting as unknown, past
   * {@link MAX_MISSING_READS} — and it leaves `run` undefined, so `polling`
   * derived from `isTerminal(run)` alone stays true forever.
   */
  const [stopped, setStopped] = useState(false);

  /**
   * The caller's client, held in a ref rather than named as an effect
   * dependency.
   *
   * As a dependency it was a footgun with no warning: the natural spelling
   * `useWorkflowRun(id, { api: createWorkflowApi() })` passes a NEW object every
   * render, so the effect tore down and restarted on each one — and because it
   * opens by clearing state, every restart re-rendered and scheduled the next.
   * The result is an unbounded request loop against the agent, with `error`
   * wiped before anything can read it, and it presents as "the page polls
   * forever" rather than as a mistake at the call site. Hoisting the client is
   * still the right thing to do (both `transcription-desk` and `page()`'s doc
   * example do), but nothing enforced it and the failure was silent.
   */
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    // A new id must not show the previous run's state for one frame, which is
    // what makes the "started, still waiting" moment read as "completed".
    setRun(undefined);
    setError(undefined);
    setStopped(false);
    if (!runId) return;
    // The no-client default is built lazily and ONCE per loop — as a render-time
    // default it would be a fresh object per render, the same hazard the ref
    // above exists for.
    let fallback: WorkflowApi | undefined;
    const getClient = (): WorkflowApi => {
      const current = apiRef.current;
      if (current) return current;
      fallback ??= createWorkflowApi();
      return fallback;
    };
    const onRun = (next: WorkflowRun<R>): void => {
      setRun(next);
      setError(undefined);
    };
    // The stream first, the poll as its fallback. Both are stopped by the returned
    // teardown, and only one is ever running: `watchRunEvents` hands over exactly
    // once, and does not hand over after the run settled.
    let stopPoll: (() => void) | undefined;
    const stopStream = watchRunEvents<R>(
      getClient,
      runId,
      onRun,
      () => setStopped(true),
      () => {
        stopPoll = pollUntilTerminal<R>(getClient, runId, intervalMs, onRun, setError, () =>
          setStopped(true),
        );
      },
    );
    return () => {
      stopStream();
      stopPoll?.();
    };
  }, [runId, intervalMs]);

  return { run, error, polling: runId !== undefined && !stopped && !isTerminal(run) };
}
