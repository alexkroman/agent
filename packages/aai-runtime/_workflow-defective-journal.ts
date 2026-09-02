// Copyright 2026 the AAI authors. MIT license.
/**
 * The journal, with one guard REMOVED — three stores that are each a version
 * this repo actually shipped.
 *
 * A law that has never been seen to fire is indistinguishable from a law that
 * cannot fire, and `workflow-concurrent-delivery.test.ts`'s five laws had never
 * been seen to fire on anything but a property run nobody kept. That is the same
 * shape as every "gate that reports success over a scan matching nothing" this
 * repo has paid for; the difference is that a law's corpus floors say an
 * interleaving worth a claim was PRODUCED, and say nothing about whether the
 * claim can be broken.
 *
 * So each defect below is a decorator over a real {@link JournalStore}, and
 * `workflow-interleavings.test.ts` freezes one interleaving per defect: the
 * schedule that catches it is committed, so the law is demonstrated to fail on
 * every run of the suite, in milliseconds, with no random seed involved.
 *
 * ## They are HISTORY, not inventions
 *
 * Every one is a guard that was added because its absence cost something, and
 * the module doc it comes from is quoted at each. That matters twice over: a
 * made-up defect proves a law can fire on a store nobody would write, and a real
 * one proves the law would have caught the bug that was actually shipped.
 *
 * ## Decorators, never edits
 *
 * The alternative — reverting the guard in `workflow-journal-memory.ts` while a
 * property runs — is how a revert gets committed by accident, and it cannot be
 * expressed as a test at all. A decorator is a value a spec passes in, so both
 * arms of the claim (the healthy store holds, the defective one does not) run in
 * the same file, next to each other.
 */

import { isTerminalStatus, type JournalStore } from "./workflow-journal-types.ts";

/** Which guard a defective store has had taken out. */
export type JournalDefect =
  | "unconditionalClose"
  | "overwritingAppend"
  | "unguardedStatus"
  | "silentDuplicateCreate";

/**
 * A store with `defect` removed, over `inner`.
 *
 * Everything not named is delegated unchanged, so a scenario run against one of
 * these differs from the healthy run in exactly one behaviour.
 */
export function defectiveJournal(inner: JournalStore, defect: JournalDefect): JournalStore {
  switch (defect) {
    case "silentDuplicateCreate":
      return { ...inner, createRun: (record) => createSilently(inner, record) };
    case "unconditionalClose":
      return { ...inner, closeHook: (runId, key) => closeUnconditionally(inner, runId, key) };
    case "overwritingAppend":
      return { ...inner, appendStep: (runId, entry) => overwrite(inner, runId, entry) };
    default:
      return {
        ...inner,
        setStatus: (runId, next, patch, expect) => moveUnguarded(inner, runId, next, patch, expect),
      };
  }
}

/**
 * `closeHook` without its compare-and-set on `delivered`.
 *
 * The shipped half-fix, quoted from `JournalStore.closeHook`:
 *
 * > Unconditional, it prevented only half the divergence it is documented to
 * > prevent: the engine reads the deadline, then closes, and a signal landing
 * > between the two left this walk taking the TIMED-OUT branch while every later
 * > replay read `delivered: true` and took the ANSWERED one.
 *
 * Caught by LAW 4 — hook uniqueness — and by `checkHookExclusivity`.
 *
 * Reaching the store at all still matters: a close on a wait that is GONE has to
 * keep answering `true`, because a terminal run has already given its tokens
 * back and the caller's timeout stands. Only the `delivered` test is taken out.
 */
async function closeUnconditionally(
  inner: JournalStore,
  runId: string,
  key: string,
): Promise<boolean> {
  await inner.closeHook(runId, key);
  return true;
}

/**
 * `createRun` answering SUCCESS for an id that is already taken.
 *
 * The one defect here that shipped to production rather than being a guard
 * somebody nearly left out. The platform store's `createRun` was
 * `on conflict (slug, run_id) do nothing` with no `returning`, so zero rows and
 * one row were the same answer:
 *
 * > Two racing starts on one id therefore both believed they had won and the
 * > loser's `input` was discarded, on the platform arm only, i.e. **for every
 * > deployed agent**.
 * > — `aai-server/platform-workflow-journal.ts`, `PlatformWorkflowRunTakenError`
 *
 * And the conformance suite could not see it: *"its platform arm is a fake
 * transport over the memory reference"*, which refuses. Only a Postgres scenario
 * run could. That is what this decorator is for — it puts the same behaviour in
 * front of the memory store, so the claim is checkable in the UNIT tier by
 * whatever is looking, at whatever tier that thing runs.
 *
 * Caught by LAW 5 — start uniqueness, whose second half is the data loss: *"the
 * run must carry the WINNING caller's input, because a `start` that resolved
 * handed its caller an id, and an id naming somebody else's input is a discarded
 * run the caller believes it owns"* — and by `checkRunIdentity`, which sees the
 * second accepted `createRun` directly.
 */
async function createSilently(
  inner: JournalStore,
  record: Parameters<JournalStore["createRun"]>[0],
): Promise<void> {
  // Swallowed, exactly as a `do nothing` with no `returning` swallows it: the
  // caller is told the id is theirs and the stored run is somebody else's.
  await inner.createRun(record).catch(() => undefined);
}

/**
 * `setStatus`'s TERMINAL move without its compare-and-set.
 *
 * `JournalStore.setStatus` says `expect` *"is what stops two deliveries of the
 * same message both completing a run … the failure it prevents is a cancelled
 * run being marked `completed` by a worker that had not noticed."*
 *
 * Caught by LAW 3 — terminal uniqueness — and by `checkTerminalMoves`.
 *
 * Only the terminal move loses its guard. Dropping `expect` from every write
 * would also un-terminal a FINISHED run — `execute` opens each delivery with
 * `setStatus(runId, "running", …, ["pending", "running"])` — which is a second,
 * louder defect that would mask this one.
 */
function moveUnguarded(
  inner: JournalStore,
  runId: string,
  next: Parameters<JournalStore["setStatus"]>[1],
  patch: Parameters<JournalStore["setStatus"]>[2],
  expect: Parameters<JournalStore["setStatus"]>[3],
): Promise<boolean> {
  return inner.setStatus(runId, next, patch, isTerminalStatus(next) ? undefined : expect);
}

/**
 * `appendStep` with the FIRST writer no longer authoritative.
 *
 * The real store resolves *"the entry that is now authoritative — the one
 * already stored, when there was one — so the engine returns the FIRST result
 * rather than its own, which is what keeps a replay deterministic across a
 * double execution."* Take that away and each walk reads back its own entry.
 *
 * Caught by `checkStepEntries` rather than by the five laws, and the asymmetry
 * is the reason `ConcurrentScenario` carries a write log at all: LAW 2 compares
 * a step's `{status, output}`, which two deterministic walks of one generated
 * body agree on — while `attempts` and `finishedAt`, which they do NOT agree on,
 * are what a resume reads to decide whether a step was abandoned.
 *
 * There is no way to express "overwrite" through the interface, which has no
 * `updateStep` on purpose, so the overwrite is faked the only way a caller can:
 * answer this walk's own entry instead of the stored one.
 */
async function overwrite(
  inner: JournalStore,
  runId: string,
  entry: Parameters<JournalStore["appendStep"]>[1],
) {
  await inner.appendStep(runId, entry);
  return entry;
}
