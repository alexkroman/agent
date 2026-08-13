// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 1.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * The browser half of a durable run: one client hoisted out of the component,
 * the two hooks that start and watch, and the narrowing that makes a completed
 * run's `output` typed rather than `unknown`.
 */

import {
  createWorkflowApi,
  DEFAULT_WORKFLOW_POLL_MS,
  isTerminal,
  MAX_MISSING_READS,
  type UseWorkflowRunResult,
  type UseWorkflowSubmitOptions,
  type UseWorkflowsOptions,
  type UseWorkflowsResult,
  useWorkflowRun,
  useWorkflowSubmit,
  useWorkflows,
  type WorkflowApi,
  type WorkflowApiOptions,
  type WorkflowRun,
  type WorkflowSubmission,
  type WorkflowSummary,
} from "../../../index.ts";

type Digest = { headline: string };

/**
 * Hoisted deliberately: `useWorkflowRun` holds the client in a ref precisely so
 * a fresh object per render cannot restart its watch, and building one in render
 * still allocates a `fetch` closure every time.
 */
const options: WorkflowApiOptions = { baseUrl: "/" };
const api: WorkflowApi = createWorkflowApi(options);

/**
 * Every route the client covers, which is `ctx.workflows` spelled over HTTP.
 *
 * `api.get` is untyped by design — the id is all the caller has — so the run
 * here carries an `unknown` output, and `useWorkflowRun<R>` below is where a
 * page names the shape.
 */
export async function drive(): Promise<WorkflowRun | undefined> {
  const listed: WorkflowSummary[] = await api.list();
  const runId = await api.start(
    listed[0]?.name ?? "digest",
    { url: "https://example.com" },
    {
      key: "caller-42",
    },
  );
  const waited = await api.startAndWait("digest", { url: "https://example.com" }, { wait: 10_000 });
  const found = await api.find("digest", "caller-42", { limit: 5 });
  const recent = await api.recent("digest", { limit: 5 });
  const response: Response = await api.watch(runId, AbortSignal.timeout(60_000));
  await api.cancel(runId);
  console.debug(waited.status, found.length, recent.length, response.ok);

  const run = await api.get(runId, { wait: 5000 });
  // The guard narrows to the terminal arms, so `output` exists on the branch.
  return isTerminal(run) && run.status === "completed" ? run : undefined;
}

export function Watcher({ runId }: { runId?: string }) {
  // The generic is what makes `run.status === "completed"` narrow to a TYPED
  // `run.output` instead of `unknown`.
  const result: UseWorkflowRunResult<Digest> = useWorkflowRun<Digest>(runId, {
    api,
    intervalMs: DEFAULT_WORKFLOW_POLL_MS,
  });
  const { run, polling, error } = result;
  if (error !== undefined) return <p>{error}</p>;
  if (run?.status === "completed") return <p>{run.output.headline}</p>;
  return <p>{polling ? "working…" : `gave up after ${MAX_MISSING_READS} reads`}</p>;
}

const submitOptions: UseWorkflowSubmitOptions = {
  api,
  key: "caller-42",
  wait: 5000,
  intervalMs: DEFAULT_WORKFLOW_POLL_MS,
};

export function SubmitPanel() {
  // `pending` covers the RUN, not the POST.
  const submission: WorkflowSubmission<Digest> = useWorkflowSubmit<Digest>("digest", submitOptions);
  const listOptions: UseWorkflowsOptions = { api, skip: false };
  const listing: UseWorkflowsResult = useWorkflows(listOptions);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submission.submit({ url: "https://example.com" });
      }}
    >
      <button type="submit" disabled={submission.pending || listing.loading}>
        {submission.error ?? `${listing.workflows.length} workflow(s)`}
      </button>
      <button type="button" onClick={submission.reset}>
        reset
      </button>
      <output>{submission.run?.status}</output>
    </form>
  );
}
