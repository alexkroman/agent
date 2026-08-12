// Copyright 2026 the AAI authors. MIT license.
/**
 * The journal's READ half — turning run rows into {@link WorkflowRunSnapshot}s.
 *
 * Split from `workflow-store.ts` when it reached the 500-line cap. The seam is
 * reads-versus-writes: nothing here mutates a run, and the three methods share one
 * column list and one row mapper, which is exactly why they belong together — the
 * mapper is the only place a stored row becomes the DISCRIMINATED snapshot every
 * consumer narrows on, and two copies of that mapping would drift on `status`.
 *
 * Spread into the store rather than exposed separately, so `WorkflowStore` stays
 * one surface for its callers.
 *
 * @internal
 */

import type { Db } from "../sdk/db.ts";
import type { WorkflowRunSnapshot, WorkflowRunStatus } from "../sdk/workflow.ts";

/** One run row, as both reads select it. */
type RunRow = {
  run_id: string;
  workflow: string;
  status: WorkflowRunStatus;
  output: unknown;
  error: string | null;
  correlation_key: string | null;
  wake_at_ms: number | null;
  steps_completed: number;
};

/** Columns both reads need, so the two cannot drift apart. */
const RUN_COLUMNS = `run_id, workflow, status, output, error, correlation_key, steps_completed,
                (extract(epoch from wake_at) * 1000)::float8 as wake_at_ms`;

/**
 * Row → {@link WorkflowRunSnapshot}.
 *
 * The snapshot is discriminated on `status`, which is what makes this a switch
 * rather than the conditional spreads it replaced: a status-defined field is no
 * longer "included when non-null" but required by the member it belongs to, so
 * the type is what stops a failed run reporting a stale `output` column left by
 * an earlier completed attempt of the same id.
 *
 * The two fallbacks are unreachable through this store's own writes (`fail`
 * always records a message, `suspend` always records a wake time) and are chosen
 * to be honest rather than defensive: a wake time nothing recorded means DUE NOW,
 * and a failure with no message still has to say it failed.
 */
function toSnapshot(row: RunRow): WorkflowRunSnapshot {
  const base = {
    runId: row.run_id,
    workflow: row.workflow,
    stepsCompleted: row.steps_completed,
    ...(row.correlation_key !== null ? { key: row.correlation_key } : {}),
  };
  switch (row.status) {
    case "completed":
      return { ...base, status: "completed", output: row.output };
    case "failed":
      return { ...base, status: "failed", error: row.error ?? "workflow run failed" };
    case "sleeping":
      return { ...base, status: "sleeping", wakeAt: row.wake_at_ms ?? 0 };
    case "cancelled":
      return { ...base, status: "cancelled" };
    default:
      return { ...base, status: row.status };
  }
}

/** The read-only third of `WorkflowStore`, bound to one `Db`. */
export function createReadMethods(db: Db) {
  return {
    async get(runId: string): Promise<WorkflowRunSnapshot | undefined> {
      const rows = await db.query<RunRow>(
        `select ${RUN_COLUMNS} from aai_workflow_runs where run_id = $1`,
        [runId],
      );
      const row = rows[0];
      return row ? toSnapshot(row) : undefined;
    },

    async findByKey(workflow: string, key: string, limit: number): Promise<WorkflowRunSnapshot[]> {
      const rows = await db.query<RunRow>(
        `select ${RUN_COLUMNS} from aai_workflow_runs
          where workflow = $1 and correlation_key = $2
          order by created_at desc
          limit $3`,
        [workflow, key, limit],
      );
      return rows.map(toSnapshot);
    },

    async recent(workflow: string, limit: number): Promise<WorkflowRunSnapshot[]> {
      const rows = await db.query<RunRow>(
        `select ${RUN_COLUMNS} from aai_workflow_runs
          where workflow = $1
          order by created_at desc
          limit $2`,
        [workflow, limit],
      );
      return rows.map(toSnapshot);
    },
  };
}
