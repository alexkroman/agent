// Copyright 2026 the AAI authors. MIT license.
/**
 * Browser client for the workflow HTTP API (`aai/host/workflow-api.ts`).
 *
 * This is the whole client half of a WORKFLOW APP: an agent whose front door is
 * a form rather than a microphone (`workflowApp()`) starts runs
 * here and watches them for the answer. It deliberately does NOT go through
 * `SessionCore` — there is no socket, no audio graph, and no session to resume.
 *
 * The one thing worth knowing before using it: **a run outlives the page.**
 * Starting one resolves as soon as the run is created, so `runId` is the only
 * handle that matters and it stays valid across a reload, a different device, or
 * `curl` — which is what makes `useWorkflowRun` a watch rather than a
 * subscription to something the page owns.
 *
 * Everything here is one REQUEST: one call, one answer, no React. The loop that
 * keeps asking lives in `use-workflow-run.ts`, and the streaming fast path under
 * it in `workflow-events.ts`.
 */

import {
  clampWorkflowWait,
  MAX_WORKFLOW_WAIT_MS,
  type WorkflowRunSnapshot,
  type WorkflowSummary,
} from "@alexkroman1/aai";
import { responseErrorMessage } from "@alexkroman1/aai/utils";
import { pageBaseUrl } from "./_utils.ts";
import { buildAgentUrl } from "./client-config.ts";

/**
 * A run's observable state.
 *
 * Aliased from the SDK rather than restated. `import type` is erased entirely,
 * so a second definition of the fields and the five-member status union would
 * buy nothing and cost the one thing that matters — nothing would assert the two
 * agree, so a status added to the SDK would never reach the browser type.
 *
 * `WorkflowRun` keeps the shorter name because it is what a page's own code
 * writes; nothing in a browser needs the word "snapshot" to know a read returns
 * one.
 *
 * It is GENERIC on the run's output, and a page supplies it — see
 * {@link useWorkflowRun}. It does NOT have to restate that type: a page can name
 * its own workflow and derive the rest with `WorkflowOutputOf`, pulling no
 * server graph into the bundle.
 *
 * @public
 */
export type WorkflowRun<R = unknown> = WorkflowRunSnapshot<R>;

/**
 * A workflow's own output type, and the shape `GET /workflows` lists — both
 * re-exported so a page needs ONE import to type its runs and render its form.
 */
export type { WorkflowOutputOf, WorkflowSummary } from "@alexkroman1/aai";

/**
 * A run status nothing will change again.
 *
 * Re-exported from the SDK rather than defined here. A second implementation
 * listing two of the three terminal statuses would leave a cancelled run polled
 * forever by a page while the agent considered it finished — the kind of drift a
 * status predicate beside the status union cannot have.
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
  /** Declared workflows: name, description, and the input schema to render. */
  list(): Promise<WorkflowSummary[]>;
  /**
   * Start a run and resolve its id WITHOUT waiting for it — the point of the
   * mechanism. Rejects when the name is not declared or the input fails the
   * workflow's schema, both of which are 400s carrying the reason.
   *
   * `key` is a correlation handle the page chooses, so the run can be found
   * again later without the id — a signed-in user, an upload, a device. Pass one
   * when the page might be reloaded before the run finishes and you would rather
   * look it up than remember the id.
   */
  start(workflow: string, input?: unknown, options?: { key?: string }): Promise<string>;
  /**
   * Start a run and resolve the FINISHED one — the synchronous call.
   *
   * What a form wants, and what {@link WorkflowApi.start} deliberately is not:
   * one request in, one result out, with no watch to wire up. The agent holds
   * the request open until the run settles or its own budget expires, so a run
   * that is still going when the wait runs out resolves NON-terminal — check
   * `isTerminal`, or hand the id to {@link useWorkflowRun} and carry on.
   *
   * `wait` is clamped to `MAX_WORKFLOW_WAIT_MS` at both ends, by the same
   * function, so this can never be waiting on a request the agent already
   * answered.
   */
  startAndWait(
    workflow: string,
    input?: unknown,
    options?: { key?: string; wait?: number },
  ): Promise<WorkflowRun>;
  /**
   * Read a run's state. Resolves undefined for an unknown id.
   *
   * Deliberately NOT generic on the output, even though a page wants it typed: a
   * generic METHOD has to be implemented generically, which would make every
   * test double and every hand-written stub of this client generic too. The type
   * parameter lives on {@link useWorkflowRun} instead, which is where a page
   * states what it expects anyway.
   */
  get(runId: string, options?: { wait?: number }): Promise<WorkflowRun | undefined>;
  /** Runs of `workflow` started with `key`, newest first. */
  find(workflow: string, key: string, options?: { limit?: number }): Promise<WorkflowRun[]>;
  /**
   * Runs of `workflow`, newest first, whatever key they carry.
   *
   * The operator's read where {@link WorkflowApi.find} is the app's — a console
   * has no correlation key to ask about, and most runs carry none (a page holds
   * its own `runId`). Two methods rather than one nullable key, so a caller
   * meaning "this user's runs" cannot silently widen to every user's.
   */
  recent(workflow: string, options?: { limit?: number }): Promise<WorkflowRun[]>;
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
};

/**
 * Read the server's error sentence out of a failed response.
 *
 * Every route answers `{ error }`, and that text is the whole diagnostic — an
 * unknown workflow names the declared ones, a bad input names the schema issues.
 * A body that is not that shape degrades to the status, which is what a proxy or
 * a gateway in front of the agent would produce.
 */
async function failure(res: Response): Promise<Error> {
  return new Error(await responseErrorMessage(res, "Workflow API"));
}

/**
 * Create a workflow API client.
 *
 * Hoist it out of the component that uses it. `useWorkflowRun` holds the client
 * in a ref precisely so a fresh object per render does not restart its watch,
 * but a client built in render is still a new `fetch` closure every time and
 * reads as though it were free.
 *
 * @public
 */
export function createWorkflowApi(opts: WorkflowApiOptions = {}): WorkflowApi {
  // `buildAgentUrl` is this package's own resolver for "a path under the agent's
  // base URL" — the same one the session's endpoints go through. A second
  // trailing-slash rule over the same `pageBaseUrl()` value is how the two
  // drift.
  const base = buildAgentUrl(opts.baseUrl ?? pageBaseUrl(), "workflows").toString();
  const auth: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};

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

    async startAndWait(
      workflow: string,
      input?: unknown,
      options?: { key?: string; wait?: number },
    ): Promise<WorkflowRun> {
      const wait = clampWorkflowWait(options?.wait ?? MAX_WORKFLOW_WAIT_MS);
      const res = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          wait,
          ...(input === undefined ? {} : { input }),
          ...(options?.key === undefined ? {} : { key: options.key }),
        }),
      });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { runId: string; run?: WorkflowRun };
      // An agent too old to understand `wait` answers `{ runId }` and nothing
      // else. Reading the run back once is what turns that into the same shape
      // rather than a `undefined` the caller has to branch on — it is one extra
      // request against a deploy that predates this, not a fallback path anyone
      // stays on.
      return body.run ?? (await this.get(body.runId, { wait })) ?? pendingRun(body.runId, workflow);
    },

    async get(runId: string, options?: { wait?: number }): Promise<WorkflowRun | undefined> {
      const wait = clampWorkflowWait(options?.wait);
      const query = wait > 0 ? `?wait=${wait}` : "";
      const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}${query}`, {
        headers: auth,
      });
      // 404 is "no such run", which is an ANSWER rather than a failure: a page
      // reading an id it just started can legitimately race the run's creation.
      if (res.status === 404) return;
      if (!res.ok) throw await failure(res);
      return (await res.json()) as WorkflowRun;
    },

    find(workflow: string, key: string, options?: { limit?: number }): Promise<WorkflowRun[]> {
      return listRuns({ workflow, key }, options?.limit);
    },

    recent(workflow: string, options?: { limit?: number }): Promise<WorkflowRun[]> {
      // No `key` in the query is what selects the keyless read server-side.
      return listRuns({ workflow }, options?.limit);
    },

    watch(runId: string, signal?: AbortSignal): Promise<Response> {
      return fetch(`${base}/runs/${encodeURIComponent(runId)}/events`, {
        headers: { ...auth, Accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      });
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
  };
}

/**
 * The snapshot a `startAndWait` falls back to when the run exists and cannot be
 * read back.
 *
 * Reachable only against an agent that answered `{ runId }` and then reported no
 * such run — a replica that has not yet seen its own write. Saying `pending` is
 * both true and useful: the caller has the id, and `useWorkflowRun` takes it
 * from there.
 */
function pendingRun(runId: string, workflow: string): WorkflowRun {
  return { runId, workflow, createdAt: Date.now(), status: "pending" };
}
