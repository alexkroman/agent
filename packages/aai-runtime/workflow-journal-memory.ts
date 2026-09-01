// Copyright 2026 the AAI authors. MIT license.
/**
 * A {@link JournalStore} in one process's memory.
 *
 * Two callers, and they want the same thing for different reasons:
 *
 * - **`aai dev` with no `DATABASE_URL`** — the honest trade the Local World made
 *   before it, stated the same way: a restart forgets in-flight runs. Trying a
 *   workflow out should not require provisioning a database.
 * - **Every spec of the engine.** This is the reference implementation of the
 *   contract, so a backend that disagrees with it has a bug — which is why the
 *   compare-and-set and the append idempotency are real here rather than
 *   approximated. A fake that is laxer than the interface lets the engine pass
 *   its specs while depending on something Postgres will not give it.
 *
 * ## It is genuinely atomic, and that is not free-by-being-single-threaded
 *
 * A JavaScript `await` is a yield, so "one thread" does not mean "no
 * interleaving": two deliveries of the same run in one process really can sit
 * inside {@link JournalStore.setStatus} at once. Every method here therefore
 * completes its read-and-write with no `await` between the two — the maps are
 * synchronous and the `async` is only the interface's shape. Adding an `await`
 * inside one of these bodies would reintroduce the race the compare-and-set
 * exists to close.
 */

import type {
  HookRecord,
  JournalStore,
  RunRecord,
  RunStatus,
  SleepRecord,
  StepEntry,
} from "./workflow-journal-types.ts";

/** One run's mutable state, kept together so a run is one map lookup. */
type Slot = {
  record: RunRecord;
  /** Settled steps in settle order — `readSteps`'s contract. */
  steps: StepEntry[];
  /** By `key`, so `appendStep`'s idempotency is a lookup rather than a scan. */
  byKey: Map<string, StepEntry>;
  /** Attempts consumed per step key. */
  attempts: Map<string, number>;
  /** Durable waits by key. Mutable, unlike `steps` — see `SleepRecord`. */
  sleeps: Map<string, SleepRecord>;
  /** Outstanding hooks by key. The token index below points back at these. */
  hooks: Map<string, HookRecord>;
};

/**
 * Newest first, with the id breaking a tie.
 *
 * `createdAt` alone is not a total order — two runs started in the same
 * millisecond are ordinary under a fan-out — so the id is what makes the
 * listing STABLE across calls rather than merely sorted. Code-unit comparison
 * and never `localeCompare`: with no explicit locale that answers to the
 * runtime's ICU default, so the same two runs would order differently on two
 * machines.
 */
function newestFirst(a: RunRecord, b: RunRecord): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? 1 : -1;
}

/**
 * Build an in-memory journal.
 *
 * @internal
 */
export function createMemoryJournal(): JournalStore {
  const runs = new Map<string, Slot>();
  /**
   * Token to the hook holding it, so a signal is one lookup rather than a scan
   * of every run. It is also what makes a duplicate token DETECTABLE — a scan
   * would find one too, but a signaller's latency should not grow with the
   * number of runs the store has ever held.
   */
  const byToken = new Map<string, { runId: string; key: string }>();

  /** The slot, or a throw naming the run — every method below needs one. */
  function slotOf(runId: string): Slot | undefined {
    return runs.get(runId);
  }

  return {
    async createRun(record: RunRecord): Promise<void> {
      // Rejects rather than overwrites: the id is the caller's, so a collision
      // is two starts racing and silently keeping the second would discard a run
      // somebody is already holding an id for.
      if (runs.has(record.runId)) {
        throw new Error(`workflow run ${record.runId} already exists`);
      }
      runs.set(record.runId, {
        record: { ...record },
        steps: [],
        byKey: new Map(),
        attempts: new Map(),
        sleeps: new Map(),
        hooks: new Map(),
      });
    },

    async getRun(runId: string): Promise<RunRecord | undefined> {
      const slot = slotOf(runId);
      // A COPY, so a caller that mutates what it was handed cannot edit the
      // store — the one way a memory backend can differ from a real one in a
      // direction that hides a bug rather than causing one.
      return slot ? { ...slot.record } : undefined;
    },

    async listRuns(workflow: string, limit: number): Promise<RunRecord[]> {
      const matching: RunRecord[] = [];
      for (const slot of runs.values()) {
        if (slot.record.workflow === workflow) matching.push({ ...slot.record });
      }
      matching.sort(newestFirst);
      return matching.slice(0, limit);
    },

    async setStatus(
      runId: string,
      next: RunStatus,
      patch?: { output?: unknown; error?: { message: string } },
      expect?: readonly RunStatus[],
    ): Promise<boolean> {
      const slot = slotOf(runId);
      if (!slot) return false;
      if (expect && !expect.includes(slot.record.status)) return false;
      slot.record.status = next;
      if (patch && "output" in patch) slot.record.output = patch.output;
      if (patch?.error) slot.record.error = patch.error;
      return true;
    },

    async readSteps(runId: string): Promise<StepEntry[]> {
      return (slotOf(runId)?.steps ?? []).map((entry) => ({ ...entry }));
    },

    async claimAttempt(runId: string, key: string): Promise<number> {
      const slot = slotOf(runId);
      if (!slot) throw new Error(`workflow run ${runId} not found`);
      const next = (slot.attempts.get(key) ?? 0) + 1;
      slot.attempts.set(key, next);
      return next;
    },

    async claimSleep(
      runId: string,
      key: string,
      wakeAt: number,
      correlationId: string | undefined,
    ): Promise<SleepRecord> {
      const slot = slotOf(runId);
      if (!slot) throw new Error(`workflow run ${runId} not found`);
      // First write wins. A replay re-evaluates `ctx.sleep(60_000)` and would
      // otherwise store a deadline 60s further out on every delivery.
      const existing = slot.sleeps.get(key);
      if (existing) return { ...existing };
      const record: SleepRecord = { wakeAt, woken: false, correlationId };
      slot.sleeps.set(key, record);
      return { ...record };
    },

    async wakeSleeps(
      runId: string,
      correlationIds: readonly string[] | undefined,
    ): Promise<number> {
      const slot = slotOf(runId);
      if (!slot) return 0;
      const now = Date.now();
      let stopped = 0;
      for (const record of slot.sleeps.values()) {
        // Counted only when this call CHANGED something: an elapsed or
        // already-woken wait is not one this call stopped.
        if (record.woken || record.wakeAt <= now) continue;
        if (correlationIds && !correlationIds.includes(record.correlationId ?? "")) continue;
        record.woken = true;
        stopped++;
      }
      return stopped;
    },

    async claimHook(runId: string, key: string, token: string): Promise<HookRecord> {
      const slot = slotOf(runId);
      if (!slot) throw new Error(`workflow run ${runId} not found`);
      const existing = slot.hooks.get(key);
      if (existing) return { ...existing };
      // A token held by a different run or a different wait is a bug rather than
      // a race: one signal would resolve whichever the store found first and the
      // other wait would never end. Failing the run says so.
      const owner = byToken.get(token);
      if (owner && !(owner.runId === runId && owner.key === key)) {
        throw new Error(
          `workflow hook token ${JSON.stringify(token)} is already held by run ${owner.runId}`,
        );
      }
      const record: HookRecord = { token, delivered: false };
      slot.hooks.set(key, record);
      byToken.set(token, { runId, key });
      return { ...record };
    },

    async closeHook(runId: string, key: string): Promise<void> {
      const record = slotOf(runId)?.hooks.get(key);
      if (record) record.closed = true;
    },

    async deliverHook(token: string, payload: unknown): Promise<string | undefined> {
      const owner = byToken.get(token);
      if (!owner) return undefined;
      const record = runs.get(owner.runId)?.hooks.get(owner.key);
      // Already answered, or the window closed. Both are the same refusal for
      // the same reason: a body is replayed and must read the same answer every
      // time, or two walks of it diverge.
      if (!record || record.delivered || record.closed) return undefined;
      record.delivered = true;
      record.payload = payload;
      return owner.runId;
    },

    async appendStep(runId: string, entry: StepEntry): Promise<StepEntry> {
      const slot = slotOf(runId);
      if (!slot) throw new Error(`workflow run ${runId} not found`);
      // Idempotent on `key`: the FIRST entry stays authoritative, so two
      // executions that both ran the step agree on what it returned.
      const existing = slot.byKey.get(entry.key);
      if (existing) return { ...existing };
      const stored = { ...entry };
      slot.byKey.set(entry.key, stored);
      slot.steps.push(stored);
      return { ...stored };
    },
  };
}
