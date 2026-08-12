// Copyright 2026 the AAI authors. MIT license.
/**
 * A {@link WorkflowStore} in a Map — the journal without Postgres.
 *
 * It ships (it used to live in `_workflow-test-utils.ts`) for ONE caller:
 * `aai dev` with no `DATABASE_URL`. Provisioning a database to try `workflow()`
 * locally is friction with no upside, and the seam plus the implementation both
 * already existed — as a test fake described as modelling the claim rules
 * faithfully, which is exactly what a dev backend needs.
 *
 * **It is not selectable in production, and that is a property of the wiring
 * rather than a warning.** The SDK never chooses it: `createRuntime` uses
 * Postgres unless a caller passes `workflowStore`, and the only caller that does
 * is the CLI's dev server. A deployed guest passes nothing, so a durability
 * primitive whose guarantee depends on a deploy flag — the one shape worse than
 * not having the primitive, because it fails on the day you ship — cannot arise.
 *
 * What it does NOT survive: the process. Every run is lost on restart, which is
 * the whole thing the Postgres journal exists to prevent, so `aai dev` says so
 * out loud at boot.
 */

import type { WorkflowRunSnapshot, WorkflowRunStatus } from "../sdk/workflow.ts";
import type { ClaimedRun, WorkflowStore } from "./workflow-store.ts";

/** One journaled run, as the memory store holds it. */
export type MemoryRun = {
  workflow: string;
  input: unknown;
  status: WorkflowRunStatus;
  /** The correlation key `start({ key })` supplied, when it supplied one. */
  key?: string | undefined;
  /**
   * The token that will resume a run parked on `ctx.waitFor`.
   *
   * Explicitly `| undefined` for the same reason `wakeAt` is: clearing it on
   * resume is what makes a token single-use, and an optional-only field cannot
   * express "present and cleared" distinctly enough for the fake to model it.
   */
  waitToken?: string | undefined;
  /** Who the run belongs to — see `ADD_OWNER_SCOPE`. Undefined for no identity. */
  ownerScope?: string | undefined;
  /** Journal id the signalled payload is recorded under — see `WorkflowStore.park`. */
  waitStep?: string | undefined;
  output?: unknown;
  error?: string | undefined;
  // Explicitly `| undefined` rather than merely optional: clearing a wake time
  // or a lease is an ASSIGNMENT of undefined here, which
  // `exactOptionalPropertyTypes` distinguishes from an absent property.
  wakeAt?: number | undefined;
  leaseUntil?: number | undefined;
  steps: Map<string, unknown>;
  /** Continuations deep — see the real store's `ADD_CONTINUATION_DEPTH`. */
  continuationDepth?: number;
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

/**
 * Statuses a run can still move out of — the fake's copy of the real store's
 * `LIVE` list, and load-bearing for the same two reasons: a claim may only take
 * over a live run, and the three settling writes must NO-OP on a terminal one so
 * a cancel cannot be overwritten by a slower executor's `complete`.
 */
const LIVE: ReadonlySet<WorkflowRunStatus> = new Set(["pending", "sleeping", "running"]);

/**
 * Row -> snapshot, mirroring the real store's `toSnapshot`.
 *
 * Shared by `get` and `findByKey` for the same reason it is shared there: the
 * snapshot is a discriminated union, so which fields exist is decided by the
 * status in exactly one place.
 */
function snapshot(runId: string, run: MemoryRun): WorkflowRunSnapshot {
  const base = {
    runId,
    workflow: run.workflow,
    stepsCompleted: run.steps.size,
    ...(run.key !== undefined ? { key: run.key } : {}),
  };
  switch (run.status) {
    case "completed":
      return { ...base, status: "completed", output: run.output };
    case "failed":
      return { ...base, status: "failed", error: run.error ?? "workflow run failed" };
    case "sleeping":
      return { ...base, status: "sleeping", wakeAt: run.wakeAt ?? 0 };
    case "cancelled":
      return { ...base, status: "cancelled" };
    default:
      return { ...base, status: run.status };
  }
}

/**
 * Does `run` satisfy a scoped read? Mirrors `scopeClause`'s SQL exactly.
 *
 * `undefined` is NO FILTER (an app with no identity, or the operator — see that
 * function's doc), and a scoped read deliberately does NOT match a NULL-scoped
 * run: one created before an app added `identify` belongs to nobody, and handing
 * it to whichever user asks first is the leak the column exists to prevent.
 */
function inScope(run: MemoryRun, scope: string | undefined): boolean {
  return scope === undefined || run.ownerScope === scope;
}

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

    create(
      runId: string,
      workflow: string,
      input: unknown,
      key?: string | undefined,
      continuationDepth = 0,
      ownerScope?: string | undefined,
    ): Promise<void> {
      runs.set(runId, {
        workflow,
        input,
        status: "pending",
        key,
        steps: new Map(),
        continuationDepth,
        ownerScope,
      });
      return Promise.resolve();
    },

    ownerScope(runId: string): Promise<string | undefined> {
      return Promise.resolve(runs.get(runId)?.ownerScope);
    },

    continuationDepth(runId: string): Promise<number> {
      return Promise.resolve(runs.get(runId)?.continuationDepth ?? 0);
    },

    claim(runId: string, leaseMs: number): Promise<ClaimedRun | undefined> {
      const run = runs.get(runId);
      if (!(run && LIVE.has(run.status))) return Promise.resolve(undefined);
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

    park(runId: string, token: string, stepId: string, timeoutAt?: number): Promise<void> {
      const run = runs.get(runId);
      if (run && LIVE.has(run.status)) {
        run.status = "sleeping";
        run.waitToken = token;
        run.waitStep = stepId;
        // A timeout IS an ordinary wake time, which is what lets the due sweep
        // recover a timed-out waitpoint with no second mechanism.
        run.wakeAt = timeoutAt;
        run.leaseUntil = undefined;
      }
      return Promise.resolve();
    },

    signal(token: string, payload: unknown): Promise<string | undefined> {
      // Modelled on the SQL's predicate, both halves: parked AND sleeping. The
      // token is cleared on resume, so a replayed webhook finds nothing — which
      // is what makes it single-use rather than merely unguessable.
      const entry = [...runs.entries()].find(
        ([, run]) => run.waitToken === token && run.status === "sleeping",
      );
      if (!entry) return Promise.resolve(undefined);
      const [runId, run] = entry;
      const stepId = run.waitStep;
      if (!stepId) return Promise.resolve(undefined);
      run.status = "pending";
      run.waitToken = undefined;
      run.waitStep = undefined;
      run.wakeAt = undefined;
      run.leaseUntil = undefined;
      run.steps.set(stepId, payload);
      return Promise.resolve(runId);
    },

    suspend(runId: string, wakeAt: number): Promise<void> {
      const run = runs.get(runId);
      if (run && LIVE.has(run.status)) {
        run.status = "sleeping";
        run.wakeAt = wakeAt;
        run.leaseUntil = undefined;
      }
      return Promise.resolve();
    },

    complete(runId: string, output: unknown): Promise<void> {
      const run = runs.get(runId);
      if (run && LIVE.has(run.status)) {
        run.status = "completed";
        run.output = output;
        run.wakeAt = undefined;
        run.leaseUntil = undefined;
      }
      return Promise.resolve();
    },

    fail(runId: string, error: string): Promise<void> {
      const run = runs.get(runId);
      if (run && LIVE.has(run.status)) {
        run.status = "failed";
        run.error = error;
        run.wakeAt = undefined;
        run.leaseUntil = undefined;
      }
      return Promise.resolve();
    },

    cancel(runId: string, scope?: string | undefined): Promise<boolean> {
      const run = runs.get(runId);
      if (!(run && LIVE.has(run.status) && inScope(run, scope))) return Promise.resolve(false);
      run.status = "cancelled";
      run.wakeAt = undefined;
      run.leaseUntil = undefined;
      return Promise.resolve(true);
    },

    retry(runId: string, scope?: string | undefined): Promise<boolean> {
      const run = runs.get(runId);
      // Terminal only, and the steps map is left alone — see the real store's doc.
      if (!(run && (run.status === "failed" || run.status === "cancelled"))) {
        return Promise.resolve(false);
      }
      if (!inScope(run, scope)) return Promise.resolve(false);
      run.status = "pending";
      run.error = undefined;
      run.wakeAt = undefined;
      run.leaseUntil = undefined;
      return Promise.resolve(true);
    },

    get(runId: string, scope?: string | undefined): Promise<WorkflowRunSnapshot | undefined> {
      const run = runs.get(runId);
      return Promise.resolve(run && inScope(run, scope) ? snapshot(runId, run) : undefined);
    },

    findByKey(
      workflow: string,
      key: string,
      limit: number,
      scope?: string | undefined,
    ): Promise<WorkflowRunSnapshot[]> {
      // Newest first, which a Map gives by reversing insertion order — the same
      // ordering the real store gets from `order by created_at desc`, without a
      // clock the fake would have to fake.
      const matched = [...runs.entries()].filter(
        ([, run]) => run.workflow === workflow && run.key === key && inScope(run, scope),
      );
      matched.reverse();
      return Promise.resolve(matched.slice(0, limit).map(([runId, run]) => snapshot(runId, run)));
    },

    recent(
      workflow: string,
      limit: number,
      scope?: string | undefined,
    ): Promise<WorkflowRunSnapshot[]> {
      // Newest first by the same reversal `findByKey` uses — see its comment.
      const matched = [...runs.entries()].filter(
        ([, run]) => run.workflow === workflow && inScope(run, scope),
      );
      matched.reverse();
      return Promise.resolve(matched.slice(0, limit).map(([runId, run]) => snapshot(runId, run)));
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

/**
 * The dev journal, typed as the plain `WorkflowStore`.
 *
 * The runtime barrel exports THIS rather than `createMemoryWorkflowStore`,
 * whose richer return type carries spec-inspection handles (`runs`, `blobs`,
 * `row`, `initCount`) that have no business being public API. Exporting the wide
 * type instead made TypeDoc pull `MemoryRun` and `MemoryBlob` into the published
 * docs, which was the referenced-but-not-documented warning telling us the
 * surface was too wide rather than that the docs needed another entry.
 *
 * Two names, because there really are two audiences: a spec wants to look inside
 * the journal, and the CLI wants a store.
 */
export function createDevWorkflowStore(): WorkflowStore {
  return createMemoryWorkflowStore();
}
