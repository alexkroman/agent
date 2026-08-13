// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * Frozen authoring example: `aai-ui:workflow` epoch 6.
 *
 * Epoch 6 adds `useWorkflowRuns` — a workflow's HISTORY, which is the half
 * `useWorkflowRun` cannot give: that one watches an id you already hold, and a
 * page reload does not hold one. Epoch 5 is unchanged and `./v5.tsx` is
 * retained, so this file demonstrates only what is new.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  isTerminal,
  type UseWorkflowRunsOptions,
  type UseWorkflowRunsResult,
  useWorkflowRuns,
} from "../../../index.ts";

type Transcript = { source: string; words: number };

/** Every option epoch 6 accepted, written out rather than inferred. */
const options: UseWorkflowRunsOptions = { limit: 10, key: "caller-1", skip: false };

/** The list, with a completed run's output typed by the parameter. */
export function History() {
  const runs: UseWorkflowRunsResult<Transcript> = useWorkflowRuns<Transcript>(
    "transcribe",
    options,
  );
  if (runs.error !== undefined) return <p>{runs.error}</p>;
  return (
    <ul>
      {runs.runs.map((run) => (
        <li key={run.runId}>
          {run.status === "completed" ? run.output.source : run.runId}
          {isTerminal(run) ? "" : " (running)"}
        </li>
      ))}
    </ul>
  );
}

/** The read is on demand: a page refreshes when its own run settles. */
export function RefreshOnSettle({ settled }: { settled: boolean }) {
  const { refresh, loading } = useWorkflowRuns("transcribe");
  if (settled && !loading) refresh();
  return <span>{loading ? "…" : ""}</span>;
}
