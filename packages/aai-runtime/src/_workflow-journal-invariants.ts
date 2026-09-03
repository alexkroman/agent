// Copyright 2026 the AAI authors. MIT license.
/**
 * What a journal write log must satisfy, RE-DERIVED — not re-asked of the store.
 *
 * `workflow-journal-memory.ts` enforces most of these at write time: `createRun`
 * rejects a duplicate id, `appendStep` is idempotent on `key`, `claimSleep`'s
 * first write wins, `closeHook` is a compare-and-set on `delivered`. So a spec
 * that asserts them by calling those methods is asking the store whether it
 * agrees with itself, and it always will. **"The store rejected it" and "the log
 * is consistent" are different claims**, and this file makes the second one.
 *
 * That distinction has already cost this repo something: there are THREE
 * backends behind one interface (memory, Postgres, the platform's HTTP proxy)
 * and their write-time guards demonstrably drift — a bare wake closing an
 * approval window, `correlationId ?? ""` folding an absent id together with an
 * empty one, `closed` answered as `undefined` where a column answers `false`,
 * `readSteps` ordering by insertion where both databases order by
 * `finished_at, key`. Every one of those was a guard that disagreed with its
 * siblings while each backend passed its own specs.
 * `journal-conformance.ts` is the arm that holds the three against each
 * OTHER; this is the arm that holds a log against the PROSE, whichever backend
 * produced it.
 *
 * ## This is NOT the `invariant()` seam, and the split is deliberate
 *
 * `@alexkroman1/aai/internal`'s `invariant(condition, name, detail?)` is for
 * O(1) in-process conditions that THROW — see "Runtime invariants" in this
 * package's guide, which is explicit that every invariant stated against it is
 * O(1) and stays on in production. These are O(n) derivations over a whole
 * run's log, so they belong in a harness and are only ever evaluated by a test.
 *
 * ## Problems are a LIST, never a chain of `expect`s
 *
 * The reason `_workflow-laws-harness.ts` gives for the same shape: a chain
 * prints only the first thing to differ, and under an interleaving the
 * informative violation is rarely the first one. A list also shrinks well when a
 * property is driving — `problems === []` reduces to the smallest log that still
 * breaks ANY of them.
 */

import type { JournalWrite } from "./_workflow-journal-log.ts";
import { isTerminalMove } from "./_workflow-journal-log.ts";
import { isTerminalStatus, type RunStatus, type StepEntry } from "./workflow-journal-types.ts";

/** A run-addressed write's run id, or `undefined` for one addressed by token. */
function runOf(write: JournalWrite): string | undefined {
  return write.m === "deliverHook" ? write.woke : write.runId;
}

/**
 * Compare two answers structurally.
 *
 * `JSON.stringify`, which is what `_workflow-laws-harness.ts` and
 * `workflow-resume-equivalence.test.ts` both use for the same job. It cannot see
 * a `Map` or a `Uint8Array` — `workflow-typed-json.ts` is what carries those
 * across a backend boundary — and that limit is acceptable here because what is
 * being compared is two reads of ONE stored value, so a codec-invisible
 * difference between them would have to have been invented by the store.
 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Every invariant this log breaks, as sentences. `[]` is a clean log.
 *
 * Deliberately takes the LOG and not the store's final state. Two of the seven
 * are unaskable of a finished journal: whether a step that ended `failed` was
 * ever offered an `ok`, and whether a wait was both delivered and closed, are
 * facts about writes the store no longer holds — the second entry was discarded
 * by the very idempotency being checked.
 */
export function checkJournalInvariants(writes: readonly JournalWrite[]): string[] {
  return [
    ...checkRunIdentity(writes),
    ...checkStepEntries(writes),
    ...checkSleepDecisions(writes),
    ...checkHookExclusivity(writes),
    ...checkTerminalMoves(writes),
  ];
}

/**
 * A run is created once, and nothing is written to it before it exists.
 *
 * `JournalStore.createRun`'s own promise is the first half — *"a collision means
 * two starts raced and exactly one may win"*. The second half is the ordering
 * `WorkflowEngine.start` is written for: *"After the record exists, never
 * before: a dispatcher that delivered first would race a worker against
 * `createRun` and report 'no such run' for a run that is about to exist."*
 *
 * Four of the store's methods are UNDER-SPECIFIED for a run that does not exist
 * — memory throws, both databases insert a row with no run to belong to — so a
 * write that landed before the create is a real defect on some backends and
 * silent corruption on others, which is exactly the case a log-derived check is
 * for.
 */
function checkRunIdentity(writes: readonly JournalWrite[]): string[] {
  const problems: string[] = [];
  const created = new Set<string>();
  for (const write of writes) {
    if (write.threw !== undefined) continue;
    if (write.m === "createRun") {
      if (created.has(write.runId)) problems.push(`run ${write.runId} was created twice`);
      created.add(write.runId);
      continue;
    }
    const runId = runOf(write);
    // A `deliverHook` that woke nothing names no run, and a write whose run was
    // created by a caller this log never saw is out of scope rather than a
    // violation — see `expectReplayable`, which logs a whole run's lifetime.
    if (runId === undefined || created.size === 0) continue;
    if (!created.has(runId)) {
      problems.push(`${write.m} landed on run ${runId} before its createRun`);
    }
  }
  return problems;
}

/**
 * A step key has ONE answer, and a step that succeeded is never journaled
 * `failed`.
 *
 * The first is `appendStep`'s idempotency seen from the caller's side: *"Resolves
 * the entry that is now authoritative — the one already stored, when there was
 * one — so the engine returns the FIRST result rather than its own, which is
 * what keeps a replay deterministic across a double execution."*
 *
 * The second is the invariant that cost this repo a durable-execution defect and
 * is quoted in the package guide: **only a walk whose own body threw may write a
 * `failed` entry.** A property harness shrank the original to a one-node body
 * under three deliveries, each of which charged an attempt and suspended inside
 * the step, so the next reach found the budget spent and appended
 * `{status: "failed", error: "step s0 exhausted 3 attempt(s)"}` over a step that
 * then SUCCEEDED — and the successful walk read that failure back out of the
 * idempotent append and failed the run. Tries are counted in the walk now and
 * the pre-body refusal is a `StepAbandonedError` rather than a journal entry, so
 * the log shape that defect produced — an `ok` offered for a key whose stored
 * entry says `failed` — is unreachable. This is what says so on every run
 * instead of on the one property that found it.
 */
function checkStepEntries(writes: readonly JournalWrite[]): string[] {
  /** First answer per `run/key`, which is the authoritative entry. */
  const authoritative = new Map<string, StepEntry | undefined>();
  /** Keys some walk offered an `ok` entry for, whatever came back. */
  const succeeded = new Set<string>();
  const problems: string[] = [];
  for (const write of writes) {
    if (write.m !== "appendStep" || write.threw !== undefined) continue;
    const at = `${write.runId}/${write.entry.key}`;
    if (write.entry.status === "ok") succeeded.add(at);
    if (!authoritative.has(at)) {
      authoritative.set(at, write.stored);
      continue;
    }
    const first = authoritative.get(at);
    if (!same(first, write.stored)) {
      problems.push(
        `step ${at} was journaled as ${JSON.stringify(first)} and read back as ${JSON.stringify(write.stored)}`,
      );
    }
  }
  for (const [at, stored] of authoritative) {
    if (stored?.status !== "failed" || !succeeded.has(at)) continue;
    problems.push(
      `step ${at} is journaled failed (${stored.error?.message ?? "no message"}) although a walk journaled it ok`,
    );
  }
  return problems;
}

/**
 * A sleep's deadline is decided ONCE.
 *
 * `claimSleep`: *"Idempotent on `key` … a body is replayed, so
 * `ctx.sleep(60_000)` is evaluated again on every delivery. Storing the
 * newly-computed deadline each time would push it 60 seconds further out per
 * replay and the run would never wake."*
 *
 * Only the DECISION is compared — the deadline, its kind and its correlation id
 * — because `woken` legitimately changes underneath a wait somebody cut short,
 * and a read that comes back woken is the mechanism working.
 */
function checkSleepDecisions(writes: readonly JournalWrite[]): string[] {
  const problems: string[] = [];
  const deadline = new Map<string, string>();
  for (const write of writes) {
    if (write.m !== "claimSleep" || write.threw !== undefined) continue;
    const at = `${write.runId}/${write.key}`;
    const decided = JSON.stringify({
      wakeAt: write.answered?.wakeAt,
      kind: write.answered?.kind,
      correlationId: write.answered?.correlationId,
    });
    const first = deadline.get(at);
    if (first === undefined) deadline.set(at, decided);
    else if (first !== decided) {
      problems.push(`sleep ${at} was decided ${first} and re-decided ${decided}`);
    }
  }
  return problems;
}

/**
 * A wait is answered or its window closes, never both.
 *
 * `closeHook`'s `true` means *"no signal may be taken through this window"*, and
 * its compare-and-set on `delivered` is what keeps that true. The half-fixed
 * version of it *"left this walk taking the TIMED-OUT branch while every later
 * replay read `delivered: true` and took the ANSWERED one"* — two walks of one
 * body disagreeing about what happened, which is the definition of a divergence.
 *
 * A wait is named by the journal key its `claimHook` registered, because that is
 * what `closeHook` is addressed by; `deliverHook` is addressed by TOKEN, so the
 * index below is what puts the two on the same footing.
 */
function checkHookExclusivity(writes: readonly JournalWrite[]): string[] {
  const tokenAt = new Map<string, string>();
  const closed = new Set<string>();
  const delivered = new Set<string>();
  for (const write of writes) {
    if (write.threw !== undefined) continue;
    if (write.m === "claimHook") tokenAt.set(write.token, `${write.runId}/${write.key}`);
    if (write.m === "closeHook" && write.closed === true) closed.add(`${write.runId}/${write.key}`);
    if (write.m === "deliverHook" && write.woke !== undefined) {
      delivered.add(tokenAt.get(write.token) ?? `${write.woke}/?${write.token}`);
    }
  }
  const problems: string[] = [];
  for (const at of delivered) {
    if (closed.has(at)) problems.push(`hook ${at} was both delivered and closed`);
  }
  return problems;
}

/**
 * A run goes terminal ONCE, and never moves afterwards.
 *
 * `setStatus`'s `expect` is *"a COMPARE-AND-SET on the current status, and it is
 * what stops two deliveries of the same message both completing a run … the
 * failure it prevents is a cancelled run being marked `completed` by a worker
 * that had not noticed."* Derived by SIMULATING each run's status from its
 * create and its accepted moves, so the count is this file's arithmetic rather
 * than the store's — the same claim `_workflow-laws-harness.ts` makes as law 3
 * off the concurrency op log, available on any log.
 */
function checkTerminalMoves(writes: readonly JournalWrite[]): string[] {
  const problems: string[] = [];
  const status = new Map<string, RunStatus>();
  for (const write of writes) {
    if (write.threw !== undefined) continue;
    if (write.m === "createRun") {
      status.set(write.runId, write.record.status);
      continue;
    }
    if (write.m !== "setStatus" || !write.moved) continue;
    const before = status.get(write.runId);
    if (before !== undefined && isTerminalStatus(before) && isTerminalMove(write)) {
      problems.push(`run ${write.runId} moved terminal twice — ${before} then ${write.next}`);
    }
    status.set(write.runId, write.next);
  }
  return problems;
}
