// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable EFFECTS of a run, as an ordered log — and an empty world rebuilt
 * from one.
 *
 * A {@link JournalStore} is the whole of what survives a crash, so the sequence
 * of writes that went into one is the run's log in the sense a durable-execution
 * system means: replay it into a fresh store and you have the world the next
 * worker boots into. That is what makes the two things built on it possible —
 * {@link rebuildJournal} loads a world back, and
 * `_workflow-journal-invariants.ts` re-derives what the log must satisfy without
 * asking the store whether it thinks so.
 *
 * ## It is NOT the op log next door, and the difference is the whole point
 *
 * `_workflow-schedule-harness.ts` also wraps every journal method and also keeps
 * a log ({@link Ev}). That one is the SCHEDULING log: it records who called
 * what and when, untyped, so the concurrency property can read an interleaving
 * back out of it. This one records what each call DID, typed, so a replica can
 * be built from it without a cast per field. Neither is a lossy copy of the
 * other: the op log cannot rebuild a store (its `args` are `unknown[]`), and
 * this one cannot see an interleaving (it is written at completion, so it holds
 * the order effects LANDED and not the order they were attempted). Two logs
 * because there are two questions.
 *
 * ## Writes are recorded on SETTLEMENT, so the order is the order of effect
 *
 * A call is appended when it comes back, not when it is made. Under overlapping
 * deliveries those differ, and the settled order is the one a replica needs:
 * replaying attempts in call order would apply a compare-and-set before the
 * write it was meant to lose to.
 *
 * ## A read is not a write, and is not recorded
 *
 * `getRun`, `listRuns`, `readSteps`, `readStep`, `readSleeps` and
 * `resumableRuns` leave the store as they found it, so nothing about them
 * belongs in a log whose purpose is to reconstruct one. They are still wrapped — the table below is exhaustive so a
 * method added to {@link JournalStore} is a compile error here rather than a
 * silently unrecorded effect.
 */

import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type {
  HookRecord,
  JournalStore,
  RunRecord,
  RunStatus,
  SleepRecord,
  StepEntry,
} from "./workflow-journal-types.ts";
import { isTerminalStatus } from "./workflow-journal-types.ts";

/** What a `setStatus` may carry. Restated so the log holds it structurally. */
export type StatusPatch = { output?: unknown; error?: { message: string } };

/**
 * One durable write, with the answer the store gave it.
 *
 * The answer is carried because half the invariants are about it rather than
 * about the arguments: `appendStep`'s idempotency is a claim about what came
 * BACK, and a compare-and-set that lost is a write with no effect to replay.
 *
 * `threw` is the third outcome. A backend may reject — memory does, for a run
 * that does not exist — and a rejected write changed nothing, so it is logged
 * and never replayed.
 */
export type JournalWrite = { threw?: string | undefined } & (
  | { m: "createRun"; runId: string; record: RunRecord }
  | {
      m: "setStatus";
      runId: string;
      next: RunStatus;
      patch: StatusPatch | undefined;
      expect: readonly RunStatus[] | undefined;
      moved: boolean;
    }
  | {
      m: "claimAttempt";
      runId: string;
      key: string;
      /** WHOSE charge — a rebuild that dropped it would merge two walks into one. */
      holder: string;
      leaseMs: number;
      attempt: number | undefined;
    }
  | { m: "releaseAttempt"; runId: string; key: string; holder: string }
  | {
      m: "claimSleep";
      runId: string;
      key: string;
      wakeAt: number;
      correlationId: string | undefined;
      kind: SleepRecord["kind"] | undefined;
      answered: SleepRecord | undefined;
    }
  | {
      m: "wakeSleeps";
      runId: string;
      correlationIds: readonly string[] | undefined;
      stopped: number | undefined;
    }
  | { m: "claimHook"; runId: string; key: string; token: string; answered: HookRecord | undefined }
  | { m: "closeHook"; runId: string; key: string; closed: boolean | undefined }
  | { m: "deliverHook"; token: string; payload: unknown; woke: string | undefined }
  | { m: "appendStep"; runId: string; entry: StepEntry; stored: StepEntry | undefined }
);

/** A journal that keeps its own write log, and the log. */
export type RecordedJournal = {
  journal: JournalStore;
  /** Every durable write, in the order it landed. */
  writes: JournalWrite[];
};

/**
 * Wrap a store so every write it accepts is appended to a log.
 *
 * Written out method by method rather than looped over `Object.keys`, for the
 * reason `scheduleJournal` gives: a loop cannot keep the signatures, so it needs
 * a cast per method, and an unwrapped method is an effect this log cannot see.
 * Spelled out, a method added to {@link JournalStore} fails to compile here.
 */
export function recordJournal(inner: JournalStore = createMemoryJournal()): RecordedJournal {
  const writes: JournalWrite[] = [];

  /** Run `call`, appending what it did — the answer, or the rejection. */
  async function log<R>(call: () => Promise<R>, made: (answer: R | undefined) => JournalWrite) {
    try {
      const answer = await call();
      writes.push(made(answer));
      return answer;
    } catch (err: unknown) {
      writes.push({ ...made(undefined), threw: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  const journal: JournalStore = {
    getRun: (runId) => inner.getRun(runId),
    listRuns: (workflow, limit) => inner.listRuns(workflow, limit),
    readSteps: (runId) => inner.readSteps(runId),
    readStep: (runId, key) => inner.readStep(runId, key),
    readSleeps: (runId) => inner.readSleeps(runId),

    createRun: (record) =>
      log(
        async () => inner.createRun(record),
        () => ({ m: "createRun", runId: record.runId, record }),
      ),
    setStatus: (runId, next, patch, expect) =>
      log(
        () => inner.setStatus(runId, next, patch, expect),
        (moved) => ({ m: "setStatus", runId, next, patch, expect, moved: moved === true }),
      ),
    claimAttempt: (runId, key, holder, leaseMs) =>
      log(
        () => inner.claimAttempt(runId, key, holder, leaseMs),
        (attempt) => ({ m: "claimAttempt", runId, key, holder, leaseMs, attempt }),
      ),
    releaseAttempt: (runId, key, holder) =>
      log(
        () => inner.releaseAttempt(runId, key, holder),
        () => ({ m: "releaseAttempt", runId, key, holder }),
      ),
    claimSleep: (runId, key, wakeAt, correlationId, kind) =>
      log(
        () => inner.claimSleep(runId, key, wakeAt, correlationId, kind),
        (answered) => ({
          m: "claimSleep",
          runId,
          key,
          wakeAt,
          correlationId,
          kind,
          answered,
        }),
      ),
    wakeSleeps: (runId, correlationIds) =>
      log(
        () => inner.wakeSleeps(runId, correlationIds),
        (stopped) => ({ m: "wakeSleeps", runId, correlationIds, stopped }),
      ),
    claimHook: (runId, key, token) =>
      log(
        () => inner.claimHook(runId, key, token),
        (answered) => ({ m: "claimHook", runId, key, token, answered }),
      ),
    closeHook: (runId, key) =>
      log(
        () => inner.closeHook(runId, key),
        (closed) => ({ m: "closeHook", runId, key, closed }),
      ),
    deliverHook: (token, payload) =>
      log(
        () => inner.deliverHook(token, payload),
        (woke) => ({ m: "deliverHook", token, payload, woke }),
      ),
    appendStep: (runId, entry) =>
      log(
        () => inner.appendStep(runId, entry),
        (stored) => ({ m: "appendStep", runId, entry, stored }),
      ),
  };
  // Assigned rather than spread in, and PRESENCE-PRESERVING: `resumableRuns` is
  // optional on the interface and an absent implementation is a declaration —
  // see `JournalStore`. A wrapper that always defined it would tell the boot
  // sweep this store can be enumerated when the one underneath cannot.
  const { resumableRuns } = inner;
  if (resumableRuns) journal.resumableRuns = (limit) => resumableRuns.call(inner, limit);
  return { journal, writes };
}

/**
 * Did this write MOVE its run into a terminal status?
 *
 * Answered from the write alone, which is why the log carries the answer: a
 * `setStatus` that lost its compare-and-set names a terminal status and changed
 * nothing. `abandon` writes one with no `expect` at all, so the guard is not
 * part of the test — see `isGuardedTerminalMove` next door, which asks the
 * narrower question the concurrency laws need.
 */
export function isTerminalMove(write: JournalWrite): boolean {
  return write.m === "setStatus" && write.moved && isTerminalStatus(write.next);
}

/**
 * Load a fresh in-memory journal from a write log.
 *
 * Only writes that LANDED are applied: a rejected call changed nothing, and a
 * compare-and-set that lost changed nothing either — replaying one would let it
 * win against a replica whose trajectory is a prefix of the original's.
 *
 * ## Take a PREFIX, never a log with a hole in it
 *
 * The obvious way to model "the worker died before it acked" is to replay the
 * whole log minus the one write that finished the run. It is wrong, and the
 * failure is not subtle: a log holding two runs that DERIVE the same hook token
 * — which is what the SDK tells authors to do — has the second run's `claimHook`
 * only because the first run settled and gave the token back. Punch that settle
 * out and the rebuild throws `token "tok_review" is already held by run wrun_1`,
 * reporting the harness's own arithmetic as a defect in a healthy pair. Two of
 * these specs are exactly that shape and found it the day this landed.
 *
 * A prefix has no such problem because it is a state the system really passed
 * through: everything after the dropped write had not happened yet. So the
 * caller slices, and this applies what it is given in order.
 *
 * ## The replica is always a MEMORY journal
 *
 * Deliberate rather than a limitation. What a rebuild asks is whether the
 * recorded effects are sufficient to re-derive the outcome, and the memory store
 * is this repo's reference implementation of the contract those effects are
 * written against. A backend-specific replica would fold "is the journal
 * sufficient" together with "does this backend agree", which is
 * `journal-conformance.ts`'s question and has its own tier.
 */
export async function rebuildJournal(writes: readonly JournalWrite[]): Promise<JournalStore> {
  const journal = createMemoryJournal();
  for (const write of writes) {
    if (write.threw !== undefined) continue;
    await applyWrite(journal, write);
  }
  return journal;
}

/**
 * Apply one landed write to a replica.
 *
 * A `switch` over the discriminant rather than a table of functions: the union
 * is what makes every field typed at the call, and a table would need one
 * narrowing per entry to get back what the `switch` gives for free.
 */
async function applyWrite(journal: JournalStore, write: JournalWrite): Promise<void> {
  switch (write.m) {
    case "createRun":
      await journal.createRun(write.record);
      return;
    case "setStatus":
      // A lost compare-and-set is not replayed — see the factory's doc.
      if (write.moved) await journal.setStatus(write.runId, write.next, write.patch, write.expect);
      return;
    case "claimAttempt":
      await journal.claimAttempt(write.runId, write.key, write.holder, write.leaseMs);
      return;
    case "releaseAttempt":
      await journal.releaseAttempt(write.runId, write.key, write.holder);
      return;
    case "claimSleep":
      await journal.claimSleep(
        write.runId,
        write.key,
        write.wakeAt,
        write.correlationId,
        write.kind,
      );
      return;
    case "wakeSleeps":
      await journal.wakeSleeps(write.runId, write.correlationIds);
      return;
    case "claimHook":
      await journal.claimHook(write.runId, write.key, write.token);
      return;
    case "closeHook":
      await journal.closeHook(write.runId, write.key);
      return;
    case "deliverHook":
      await journal.deliverHook(write.token, write.payload);
      return;
    default:
      await journal.appendStep(write.runId, write.entry);
  }
}
