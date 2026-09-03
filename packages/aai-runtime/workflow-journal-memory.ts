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

import { codeUnit, newestFirst, settledFirst, soonestFirst } from "./_workflow-journal-order.ts";
import type {
  HookRecord,
  JournalStore,
  ResumableRun,
  RunRecord,
  RunStatus,
  SleepEntry,
  SleepRecord,
  StepEntry,
} from "./workflow-journal-types.ts";
import { isTerminalStatus, JournalConflictError } from "./workflow-journal-types.ts";

/** One run's mutable state, kept together so a run is one map lookup. */
type Slot = {
  record: RunRecord;
  /**
   * Settled steps in APPEND order, which is not what `readSteps` answers with:
   * that sorts a copy by `finishedAt` then `key`, matching both databases.
   */
  steps: StepEntry[];
  /** By `key`, so `appendStep`'s idempotency is a lookup rather than a scan. */
  byKey: Map<string, StepEntry>;
  /**
   * Outstanding attempt LEASES per step key: holder to when it was claimed.
   *
   * A map rather than a count, for the same reason both databases hold a row
   * per charge — `_workflow-journal-attempts.ts` carries the argument. The
   * value is a `Date.now()`, so the expiry is a comparison against the engine's
   * own clock rather than against a second one.
   */
  attempts: Map<string, Map<string, number>>;
  /** Durable waits by key. Mutable, unlike `steps` — see `SleepRecord`. */
  sleeps: Map<string, SleepRecord>;
  /** Outstanding hooks by key. The token index below points back at these. */
  hooks: Map<string, HookRecord>;
};

/**
 * Does this wake reach that wait?
 *
 * Three refusals, and the middle one is the interesting one: a BARE wake is the
 * "send it now" call a tool makes to cut a SCHEDULE short, and a hook's deadline
 * is journaled through the same primitive — so without the `kind` test it also
 * closed any pending approval window on the run.
 */
function wakeReaches(
  record: SleepRecord,
  correlationIds: readonly string[] | undefined,
  now: number,
): boolean {
  // An elapsed or already-woken wait is not one THIS call stopped.
  //
  // **The `wakeAt <= now` half is deliberately NOT a way to rescue an overdue
  // run, and marking one `woken` here would be actively harmful.** For a while
  // the only path back to a run whose deadline had passed was a `wake`, and this
  // refused it — so an overdue sleep was unreachable through the public API and
  // the run was stranded. That is fixed where it belongs, in the DISPATCHER
  // (`JournalStore.resumableRuns` and the boot sweep in
  // `workflow-in-process.ts`): an elapsed deadline does not need waking, it needs
  // DELIVERING, and a wake that "succeeded" would still not have scheduled one.
  //
  // Two things the refusal is protecting, both broken by the tempting fix:
  //
  // - **The count.** `wakeSleeps` answers what this call CHANGED, which is what
  //   makes `{ woken: 0 }` actionable rather than a tie between "nothing was
  //   waiting" and "I woke something twice" — and `wakeUp` only re-delivers when
  //   something was stopped.
  // - **`aai-server/workflow-queue-reconcile.ts` reads `woken = false and
  //   wake_at < cutoff`** as its evidence that a run holding an open approval
  //   window has a LOST deadline. Marking an elapsed sleep woken blinds that arm,
  //   after which the reconcile's park rule hides such a run forever — i.e. the
  //   fix for one stranding bug would create a second one, on the platform, where
  //   it is least observable. Reachable today: a targeted
  //   `wakeUp(runId, [correlationId])` on a `hookTimeout` whose deadline elapsed.
  if (record.woken || record.wakeAt <= now) return false;
  if (!correlationIds) return record.kind === "sleep";
  // A wait declared with NO id is not a wait declared with `""`, and this used to
  // fold the two together (`correlationId ?? ""`, matching Postgres's
  // `coalesce(correlation_id, '')`). Both directions were wrong: an author whose
  // id list happened to contain an empty string woke every uncorrelated sleep on
  // the run, and a wait genuinely declared `""` was indistinguishable from one
  // declared nothing. The platform backend never folded them, so the contract had
  // two answers depending on where the run was deployed — found by
  // `journal-conformance-waits.ts`, which is why it is a strict compare now.
  return record.correlationId !== undefined && correlationIds.includes(record.correlationId);
}

/**
 * The earliest OUTSTANDING deadline this run is waiting on, or `undefined`.
 *
 * A woken wait is not outstanding, and an ELAPSED one is: it is the whole reason
 * this walk exists, since an elapsed deadline with no timer behind it is the
 * stranded run `resumableRuns` recovers.
 */
function earliestWake(slot: Slot): number | undefined {
  let at: number | undefined;
  for (const record of slot.sleeps.values()) {
    if (record.woken) continue;
    if (at === undefined || record.wakeAt < at) at = record.wakeAt;
  }
  return at;
}

/** Is this run parked on somebody else's answer — an OPEN window? */
function hasOpenHook(slot: Slot): boolean {
  for (const hook of slot.hooks.values()) {
    if (!(hook.delivered || hook.closed)) return true;
  }
  return false;
}

/**
 * How many TERMINAL runs are kept before the oldest are forgotten.
 *
 * The one caller with a real lifetime is `aai dev`, which stays up for a working
 * day — and a run retains its input, its output and every step's output, which
 * for the shipped templates is transcripts and audio. Unbounded, that is heap
 * growth proportional to total run payload rather than to work in flight, in the
 * process a developer leaves running. `workflow-streams.ts` caps the channel
 * holding the SMALLER values and this held the larger ones with no cap at all.
 *
 * Only terminal runs are candidates: an in-flight run is still owed a delivery,
 * and forgetting one would strand it. The recent ones are what `aai workflow` and
 * a page read back, so the cap is generous enough that a day's work is still
 * inspectable.
 */
const MAX_TERMINAL_RUNS = 200;

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

  /**
   * The slot, or `undefined`.
   *
   * Deliberately NOT a guard, and it used to claim to be one ("or a throw naming
   * the run") while returning `undefined` — with four callers hand-rolling the
   * throw right after it. A comment saying a function checks something it does
   * not is how the fifth caller comes to skip the check.
   */
  function slotOf(runId: string): Slot | undefined {
    return runs.get(runId);
  }

  /**
   * Everything a run owes the store the moment it becomes terminal.
   *
   * Its hook tokens go back FIRST: a token is held for as long as its run might
   * still be answered, and no longer. Waiting for the sweep below meant a DERIVED
   * token — which is what the SDK tells authors to use — could serve exactly one
   * run ever: `recap-workflow` derives `retention:<sessionId>`, so a caller asking
   * for a second recap in one session hit `claimHook`'s conflict, which is not a
   * suspend, so the saga compensated and deleted that transcript too.
   */
  function onRunSettled(slot: Slot): void {
    releaseTokens(slot);
    forgetOldTerminalRuns();
  }

  /** Give one slot's hook tokens back to the index. */
  function releaseTokens(slot: Slot): void {
    for (const hook of slot.hooks.values()) byToken.delete(hook.token);
  }

  /**
   * Drop the oldest terminal runs past {@link MAX_TERMINAL_RUNS}.
   *
   * `Map` preserves insertion order, which is start order, so the oldest
   * terminal runs are simply the first ones the walk meets.
   *
   * The `releaseTokens` here is a BACKSTOP rather than the release point:
   * `byToken` is the index INTO these slots, so a dropped slot whose entry
   * stayed would hold a token against a caller's next run forever — but the one
   * way a run becomes terminal is `setStatus`, which released a line earlier.
   * Kept because the cost is a walk of an empty map and the failure it guards is
   * silent, and shared with `onRunSettled` so the two cannot come apart.
   */
  function forgetOldTerminalRuns(): void {
    const terminal: string[] = [];
    for (const [runId, slot] of runs) {
      if (isTerminalStatus(slot.record.status)) terminal.push(runId);
    }
    // `slice(0, negative)` counts from the END and clamps at zero, so a store
    // under the cap drops nothing — the arithmetic is the whole guard.
    for (const runId of terminal.slice(0, terminal.length - MAX_TERMINAL_RUNS)) {
      const slot = runs.get(runId);
      if (slot) releaseTokens(slot);
      runs.delete(runId);
    }
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
      const wasTerminal = isTerminalStatus(slot.record.status);
      slot.record.status = next;
      if (patch && "output" in patch) slot.record.output = patch.output;
      if (patch?.error) slot.record.error = patch.error;
      // The one moment a run becomes a candidate for forgetting, so it is where
      // the sweep belongs — cheaper than a timer, and it cannot run while a
      // delivery is in flight.
      if (!wasTerminal && isTerminalStatus(next)) onRunSettled(slot);
      return true;
    },

    async readSteps(runId: string): Promise<StepEntry[]> {
      // Sorted rather than answered in insertion order, because BOTH databases
      // read the journal back with `order by finished_at, key` and this is the
      // reference the other two are checked against. Insertion order agrees with
      // them right up to a same-millisecond tie, which a fan-out produces
      // routinely. COPIES, so the sort cannot reorder the stored array — that
      // one is append-only and `appendStep`'s own idempotency reads it.
      //
      // Copied THEN sorted rather than spread-sorted-then-mapped, which is one
      // intermediate array instead of two on the read every walk opens with.
      return (slotOf(runId)?.steps ?? []).map((entry) => ({ ...entry })).sort(settledFirst);
    },

    async readStep(runId: string, key: string): Promise<StepEntry | undefined> {
      // Through `byKey`, never a scan of `steps`. The two hold the SAME objects
      // (see `appendStep`), so the answer is identical — and the point of this
      // method is that it asks an O(1) question, which
      // `workflow-replay-attempt.ts` states in so many words when it explains
      // why `settledSince` reaches this rather than `readSteps`. A `find` here
      // gave that back: it is on the CONTENDED path, reached once per step of
      // every overlapping walk, in exactly the runs where `steps` is longest.
      //
      // A COPY, for the same reason `readSteps` maps one: the stored entry is
      // shared with `steps` and with `appendStep`'s own idempotency check.
      const entry = slotOf(runId)?.byKey.get(key);
      return entry ? { ...entry } : undefined;
    },

    async claimAttempt(
      runId: string,
      key: string,
      holder: string,
      leaseMs: number,
    ): Promise<number> {
      const slot = slotOf(runId);
      if (!slot) throw new Error(`workflow run ${runId} not found`);
      const leases = slot.attempts.get(key) ?? new Map<string, number>();
      slot.attempts.set(key, leases);
      const cutoff = Date.now() - leaseMs;
      // A LIVE holder's `claimed_at` is left alone; an expired one's is renewed.
      // Both halves are the contract — `JournalStore.claimAttempt` argues why a
      // re-claim must not refresh a live lease, and the databases spell the same
      // rule as `on conflict … do update … where claimed_at <= cutoff`.
      const held = leases.get(holder);
      if (held === undefined || held < cutoff) leases.set(holder, Date.now());
      // Expired leases are FORGOTTEN rather than merely skipped, which the
      // databases do not bother with — they can afford a row nothing counts,
      // where this map is the process's own memory for the life of the run.
      //
      // `<` and not `<=`, matching the databases: the boundary has to be
      // inclusive or a `leaseMs` of zero sweeps away the charge this call just
      // took and answers `0`. `_workflow-journal-attempts.ts` argues it.
      for (const [who, at] of leases) if (at < cutoff) leases.delete(who);
      return leases.size;
    },

    async releaseAttempt(runId: string, key: string, holder: string): Promise<void> {
      const slot = slotOf(runId);
      if (!slot) throw new Error(`workflow run ${runId} not found`);
      // Deletes the NAMED charge, so a release that lands twice is a no-op and
      // no release can take another walk's charge. The floor the counter needed
      // is gone with the counter.
      slot.attempts.get(key)?.delete(holder);
    },

    async readSleeps(runId: string): Promise<SleepEntry[]> {
      // COPIES, and sorted by key — a sleep record is MUTABLE (`wake` sets
      // `woken`), so handing the stored object out would let a caller's snapshot
      // change under it, which is exactly the staleness the reader is written to
      // reason about. Both databases answer `order by key`.
      const sleeps = slotOf(runId)?.sleeps;
      if (!sleeps) return [];
      return [...sleeps]
        .sort(([a], [b]) => codeUnit(a, b))
        .map(([key, record]) => ({ ...record, key }));
    },

    async claimSleep(
      runId: string,
      key: string,
      wakeAt: number,
      correlationId: string | undefined,
      kind: SleepRecord["kind"] = "sleep",
    ): Promise<SleepRecord> {
      const slot = slotOf(runId);
      if (!slot) throw new Error(`workflow run ${runId} not found`);
      // First write wins. A replay re-evaluates `ctx.sleep("poll", 60_000)` and would
      // otherwise store a deadline 60s further out on every delivery.
      const existing = slot.sleeps.get(key);
      if (existing) return { ...existing };
      const record: SleepRecord = { wakeAt, woken: false, correlationId, kind };
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
        if (!wakeReaches(record, correlationIds, now)) continue;
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
        // A `JournalConflictError`, never a plain one: this is a verdict about
        // the RUN, and the engine reads the type to decide between failing the
        // run and treating the store as unavailable and retrying forever.
        throw new JournalConflictError(
          `workflow hook token ${JSON.stringify(token)} is already held by run ${owner.runId}`,
        );
      }
      // `closed: false` SPELLED OUT, not left absent. The other two backends read
      // it off a `boolean not null default false` column, so they answer `false`
      // where this answered `undefined` — invisible to every truthiness test in
      // the engine and to a `toEqual`, right up until somebody compares against
      // `false`. It is the field that decides which of two branches a replay
      // takes, so the reference implementation states it.
      const record: HookRecord = { token, delivered: false, closed: false };
      slot.hooks.set(key, record);
      byToken.set(token, { runId, key });
      return { ...record };
    },

    async closeHook(runId: string, key: string): Promise<boolean> {
      const record = slotOf(runId)?.hooks.get(key);
      // Nothing to refuse: a terminal run has already given its tokens back, so
      // no signal can be taken and the caller's timeout stands.
      if (!record) return true;
      // ANSWERED, so the window did not time out — however this walk read the
      // clock. Refusing the close is what stops it disagreeing with every later
      // replay, which will read the payload.
      if (record.delivered) return false;
      record.closed = true;
      return true;
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

    async resumableRuns(limit: number): Promise<ResumableRun[]> {
      const owed: ResumableRun[] = [];
      for (const [runId, slot] of runs) {
        if (isTerminalStatus(slot.record.status)) continue;
        const wakeAt = earliestWake(slot);
        // A park is not a stall — see the interface. Qualified by the sleep,
        // so a `waitFor(token, { timeoutMs })` whose deadline was lost is still in.
        if (wakeAt === undefined && hasOpenHook(slot)) continue;
        // Two literals rather than a conditional spread: `wakeAt` is ABSENT and
        // never explicitly `undefined`, which is what makes the three backends
        // comparable under `toEqual`.
        owed.push(wakeAt === undefined ? { runId } : { runId, wakeAt });
      }
      return owed.sort(soonestFirst).slice(0, limit);
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
