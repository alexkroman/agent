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
import type { ClaimedRun, WorkflowStore } from "./workflow-store.ts";

/** One journaled run, as the memory store holds it. */
export type MemoryRun = {
  workflow: string;
  input: unknown;
  status: WorkflowRunStatus;
  output?: unknown;
  error?: string;
  // Explicitly `| undefined` rather than merely optional: clearing a wake time
  // or a lease is an ASSIGNMENT of undefined here, which
  // `exactOptionalPropertyTypes` distinguishes from an absent property.
  wakeAt?: number | undefined;
  leaseUntil?: number | undefined;
  steps: Map<string, unknown>;
};

/** One uploaded blob, as the memory store holds it. */
export type MemoryBlob = { contentType: string; base64: string; createdAt: number };

/** A {@link WorkflowStore} in a Map, plus the handles a spec asserts on. */
export type MemoryWorkflowStore = WorkflowStore & {
  /** Live run rows, so a spec can inspect (or corrupt) journal state directly. */
  runs: Map<string, MemoryRun>;
  /** Live blob rows, so a spec can assert what an upload stored and what a sweep left. */
  blobs: Map<string, MemoryBlob>;
  /**
   * One row, throwing when it is absent.
   *
   * A `Map.get` would need a non-null assertion at every use, which this repo's
   * lint bans — and rightly: a spec asserting on a run that was never created
   * should fail by NAME here rather than as a `TypeError` on the next property
   * read.
   */
  row(runId: string): MemoryRun;
  /** How many times `init()` ran — the engine promises exactly once. */
  initCount: number;
};

const CLAIMABLE: ReadonlySet<WorkflowRunStatus> = new Set(["pending", "sleeping", "running"]);

export function createMemoryWorkflowStore(): MemoryWorkflowStore {
  const runs = new Map<string, MemoryRun>();
  const blobs = new Map<string, MemoryBlob>();
  const store: MemoryWorkflowStore = {
    runs,
    blobs,
    initCount: 0,

    row(runId: string): MemoryRun {
      const run = runs.get(runId);
      if (!run) throw new Error(`no workflow run "${runId}" in the memory store`);
      return run;
    },

    init(): Promise<void> {
      store.initCount += 1;
      return Promise.resolve();
    },

    create(runId: string, workflow: string, input: unknown): Promise<void> {
      runs.set(runId, { workflow, input, status: "pending", steps: new Map() });
      return Promise.resolve();
    },

    claim(runId: string, leaseMs: number): Promise<ClaimedRun | undefined> {
      const run = runs.get(runId);
      if (!(run && CLAIMABLE.has(run.status))) return Promise.resolve(undefined);
      // Not yet due, or still owned by a live lease — both are "someone else's".
      if (run.wakeAt !== undefined && run.wakeAt > Date.now()) return Promise.resolve(undefined);
      if (
        run.status === "running" &&
        run.leaseUntil !== undefined &&
        run.leaseUntil >= Date.now()
      ) {
        return Promise.resolve(undefined);
      }
      run.status = "running";
      run.leaseUntil = Date.now() + leaseMs;
      return Promise.resolve({ runId, workflow: run.workflow, input: run.input });
    },

    due(limit: number): Promise<string[]> {
      const now = Date.now();
      const ids: string[] = [];
      for (const [runId, run] of runs) {
        const waiting =
          (run.status === "pending" || run.status === "sleeping") &&
          (run.wakeAt === undefined || run.wakeAt <= now);
        const abandoned =
          run.status === "running" && run.leaseUntil !== undefined && run.leaseUntil < now;
        if (waiting || abandoned) ids.push(runId);
        if (ids.length === limit) break;
      }
      return Promise.resolve(ids);
    },

    completedSteps(runId: string): Promise<Map<string, unknown>> {
      return Promise.resolve(new Map(runs.get(runId)?.steps ?? []));
    },

    recordStep(runId: string, stepId: string, output: unknown): Promise<number> {
      const run = runs.get(runId);
      if (!run) return Promise.resolve(0);
      run.steps.set(stepId, output);
      return Promise.resolve(run.steps.size);
    },

    suspend(runId: string, wakeAt: number): Promise<void> {
      const run = runs.get(runId);
      if (run) {
        run.status = "sleeping";
        run.wakeAt = wakeAt;
        run.leaseUntil = undefined;
      }
      return Promise.resolve();
    },

    complete(runId: string, output: unknown): Promise<void> {
      const run = runs.get(runId);
      if (run) {
        run.status = "completed";
        run.output = output;
        run.wakeAt = undefined;
        run.leaseUntil = undefined;
      }
      return Promise.resolve();
    },

    fail(runId: string, error: string): Promise<void> {
      const run = runs.get(runId);
      if (run) {
        run.status = "failed";
        run.error = error;
        run.wakeAt = undefined;
        run.leaseUntil = undefined;
      }
      return Promise.resolve();
    },

    get(runId: string): Promise<WorkflowRunSnapshot | undefined> {
      const run = runs.get(runId);
      if (!run) return Promise.resolve(undefined);
      return Promise.resolve({
        runId,
        workflow: run.workflow,
        status: run.status,
        stepsCompleted: run.steps.size,
        ...(run.status === "completed" ? { output: run.output } : {}),
        ...(run.status === "failed" && run.error !== undefined ? { error: run.error } : {}),
        ...(run.status === "sleeping" && run.wakeAt !== undefined ? { wakeAt: run.wakeAt } : {}),
      });
    },

    putBlob(blobId: string, contentType: string, base64: string): Promise<void> {
      blobs.set(blobId, { contentType, base64, createdAt: Date.now() });
      return Promise.resolve();
    },

    getBlob(blobId: string): Promise<{ contentType: string; base64: string } | undefined> {
      const blob = blobs.get(blobId);
      return Promise.resolve(
        blob ? { contentType: blob.contentType, base64: blob.base64 } : undefined,
      );
    },

    deleteBlob(blobId: string): Promise<boolean> {
      return Promise.resolve(blobs.delete(blobId));
    },

    pruneBlobs(maxAgeMs: number): Promise<number> {
      // Modelled on the real clock rather than "delete everything", so a spec on
      // fake timers can assert that a FRESH upload survives a sweep — which is
      // the property that matters (a run sleeping between steps must still find
      // the blob it was started with).
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      for (const [id, blob] of blobs) {
        if (blob.createdAt < cutoff) {
          blobs.delete(id);
          removed++;
        }
      }
      return Promise.resolve(removed);
    },
  };
  return store;
}
