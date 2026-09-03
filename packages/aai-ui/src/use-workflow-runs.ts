// Copyright 2026 the AAI authors. MIT license.
/**
 * The RUNS a workflow has had — the list a page shows beside its form.
 *
 * `useWorkflowRun` watches one run you already hold an id for, which is the
 * right shape for the run a page just started and the wrong one for everything
 * before it. A workflow app that only offers that leaves its own history
 * unreachable: a page reload drops the id, and the only way back to yesterday's
 * transcript is to have written the id down — which is what
 * `transcription-workflow` asked people to do, with a text box for pasting one.
 *
 * `GET /workflows/runs?workflow=…` has always been able to answer this. This is
 * the hook over it, so a page renders history instead of asking for an id.
 *
 * ## It re-reads on demand, and does not poll on its own
 *
 * A list is not a live view: the run a page cares about right now is already
 * being watched by `useWorkflowRun`, and a second polling loop over the whole
 * history would broker N requests a minute on the platform to re-learn what the
 * first one already knows. So this reads once and hands back `refresh` — which
 * a page calls when its own run settles, which is exactly when the list is
 * stale.
 */

import { errorMessage } from "@alexkroman1/aai";
import { createEpoch, type Epoch } from "@alexkroman1/aai/internal";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";

/** Options for {@link useWorkflowRuns}. */
export type UseWorkflowRunsOptions = {
  /** The client to read with. Defaults to one for the page's own agent. */
  api?: WorkflowApi;
  /** Most runs to return, newest first. The agent clamps its own ceiling. */
  limit?: number;
  /**
   * Narrow to one correlation key — the `key` a run was started with.
   *
   * Omitted, the list is every recent run of the workflow, which is what an
   * operator's page wants. A page showing "your" runs passes the key it started
   * them with; there is no per-user filtering behind this, so the key IS the
   * scoping mechanism.
   */
  key?: string;
  /** Skip the read entirely — for a page that does not know its workflow yet. */
  skip?: boolean;
};

/** What {@link useWorkflowRuns} reports. */
export type UseWorkflowRunsResult<R = unknown> = {
  /** The runs, newest first. Empty until the first read lands. */
  runs: WorkflowRun<R>[];
  /** True until the first read settles, and during an explicit refresh. */
  loading: boolean;
  /** The read's failure, alongside an empty list — which is why it exists. */
  error: string | undefined;
  /** Re-read now. Call it when a run this page started reaches a terminal status. */
  refresh: () => void;
};

/**
 * Read a workflow's recent runs.
 *
 * @typeParam R - The workflow's output type, so a completed run's `output` is
 *   typed rather than `unknown`. Derive it with `WorkflowOutputOf`.
 *
 * @example
 * ```tsx
 * import { useWorkflowRuns } from "@alexkroman1/aai-ui";
 *
 * function History() {
 *   const { runs } = useWorkflowRuns("transcribe", { limit: 10 });
 *   return <ul>{runs.map((run) => <li key={run.runId}>{run.status}</li>)}</ul>;
 * }
 * ```
 *
 * @public
 */
export function useWorkflowRuns<R = unknown>(
  workflow: string | undefined,
  opts: UseWorkflowRunsOptions = {},
): UseWorkflowRunsResult<R> {
  const { api, limit, key, skip = false } = opts;
  const [runs, setRuns] = useState<WorkflowRun<R>[]>([]);
  const [loading, setLoading] = useState(!skip && workflow !== undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // The client through a ref — see `_workflow-api-ref.ts`.
  const getClient = useWorkflowApiRef(api);
  /**
   * Every read carries the epoch it started in, and a read from an earlier one
   * is DROPPED.
   *
   * Bumped by the unmount AND by each read as it starts, which is the half that
   * was missing: with only the cleanup bumping, two `refresh()` calls captured
   * the SAME epoch, so a slow earlier read overwrote a newer one's answer with
   * a staler list — the exact case the drop exists for.
   */
  const epochRef = useRef<Epoch | undefined>(undefined);
  epochRef.current ??= createEpoch();
  const epoch = epochRef.current;

  const load = useCallback((): void => {
    if (skip || workflow === undefined) return;
    const client = getClient();
    epoch.bump();
    const mine = epoch.current();
    setLoading(true);
    // A spread rather than `{ limit }`: the option is a plain optional on the
    // client, so a present-and-undefined value is an error under
    // `exactOptionalPropertyTypes`.
    const options = limit === undefined ? undefined : { limit };
    const read =
      key === undefined ? client.recent(workflow, options) : client.find(workflow, key, options);
    read
      .then((found) => {
        if (!epoch.isCurrent(mine)) return;
        setRuns(found as WorkflowRun<R>[]);
        setError(undefined);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!epoch.isCurrent(mine)) return;
        // Reported rather than swallowed: an empty list renders as "you have
        // never run this", which is a confident false statement about an agent
        // that was merely unreachable.
        setError(errorMessage(err));
        setLoading(false);
      });
    // `getClient` and `epoch` are both stable for the component's life, so
    // naming them re-creates nothing.
  }, [workflow, limit, key, skip, getClient, epoch]);

  useEffect(() => {
    load();
    return () => {
      epoch.bump();
    };
  }, [load, epoch]);

  // `load` IS the refresh: one reader, so a re-read and the first read cannot
  // drift apart, and it is stable for the dependencies above.
  const refresh = load;

  return { runs, loading, error, refresh };
}
