// Copyright 2026 the AAI authors. MIT license.
/**
 * In-memory {@link WorkflowStore} for the engine specs.
 *
 * The engine's interesting behaviour — replay, lease recovery, suspension — is
 * the half that has nothing to do with SQL, and this is what lets it be tested
 * without a database. It models the claim rules FAITHFULLY (that is the point;
 * a permissive fake would pass the contention specs for the wrong reason), and
 * reads the clock through `Date.now()` so a spec on fake timers controls
 * lease expiry and wake times the same way it controls the engine's own.
 */

import type { WorkflowRunSnapshot, WorkflowRunStatus } from "../sdk/workflow.ts";

/**
 * The in-memory journal, re-exported: it SHIPS now (see
 * `workflow-memory-store.ts`) because `aai dev` uses it, so a spec and the dev
 * server exercise one implementation rather than a fake and a real one that can
 * disagree.
 */
export {
  createMemoryWorkflowStore,
  type MemoryBlob,
  type MemoryRun,
  type MemoryWorkflowStore,
} from "./workflow-memory-store.ts";

/**
 * Narrow a snapshot to one status, throwing when it is in another.
 *
 * `WorkflowRunSnapshot` is discriminated on `status`, so reading `.error` or
 * `.output` requires establishing the status first — which every spec here wanted
 * to assert anyway. Doing both in one call is what keeps the specs from
 * re-asserting the status by hand and then reaching past the narrow; the throw
 * names the status that DID come back, which is the thing a failure needs to say.
 */
export function asStatus<S extends WorkflowRunStatus>(
  run: WorkflowRunSnapshot | undefined,
  status: S,
): Extract<WorkflowRunSnapshot, { status: S }> {
  if (run === undefined) throw new Error(`expected a ${status} run, got no run at all`);
  if (run.status !== status) {
    throw new Error(`expected a ${status} run, got ${run.status}`);
  }
  return run as Extract<WorkflowRunSnapshot, { status: S }>;
}
