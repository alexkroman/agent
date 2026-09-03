// Copyright 2026 the AAI authors. MIT license.
/**
 * A failure of the JOURNAL is not a failure of the RUN, and this is what keeps
 * the two apart.
 *
 * `replayRun`'s own doc states the contract: *"It does propagate a failure of
 * the JOURNAL itself: if the store is unreachable, the run's state is unknown
 * and the right move is to let the delivery fail and be retried, not to mark a
 * run failed on the strength of a database blip."* That was true only of the
 * calls made BEFORE the body starts — `readSteps` at the top of the walk. Every
 * other journal call the engine makes is reached FROM the body:
 * `claimAttempt`/`appendStep` inside `ctx.step`, `claimSleep`/`claimHook` inside
 * a wait, `appendStep` again inside `ctx.now`/`random`/`uuid`. A rejection there
 * unwinds through the body like any other throw, arrives at `replayRun`'s outer
 * `catch`, and `classifyThrow` has nothing to tell it from an exception the body
 * raised itself — so it answered `{ kind: "failed" }`.
 *
 * ## What that cost, measured
 *
 * The engine writes that outcome with `setStatus`, and `failed` is TERMINAL — so
 * a redelivery is a no-op (`workflow-engine.ts` reads `isTerminalStatus` to
 * decide) and the run is over. One unavailable moment in the store therefore:
 *
 * - **kills a healthy run permanently**, where the whole point of the delivery
 *   queue is that an unavailable dependency is retried;
 * - **discards a step that SUCCEEDED.** The body returned, `appendStep` could
 *   not record it, and the run is failed with the work done and unjournaled —
 *   for a paid step, money spent and nothing to show a retry;
 * - **reports the store's error as the run's error**, so `aai workflow` shows a
 *   caller "connection reset" as though their workflow had raised it.
 *
 * Reproduced in `workflow-replay.test.ts`, "a journal whose appendStep rejects":
 * three tests, all three of which resolved `{ kind: "failed" }` before this.
 *
 * ## Why a WRAPPER rather than a check at each call
 *
 * There are seven methods and four callers, and the callers are spread across
 * `workflow-replay.ts`, `-step.ts`, `-attempt.ts`, `-waits.ts` and
 * `-determinism.ts` — so a per-call `try` is five files to keep in step and a
 * new journal call is silently exempt. Wrapping the store once puts the rule
 * where the store is: any rejection from any method, on any path, is recorded on
 * the walk before it is re-thrown.
 *
 * **Nothing here AWAITS**, and that is the same load-bearing detail
 * `workflow-replay-step.ts` argues at its `return journal.appendStep(…)`: a
 * `.catch(…)` handler returns a new promise without settling the caller's, so
 * the attempt loop's own `catch` still cannot see a journal rejection and still
 * cannot retry a paid body over one.
 *
 * @module
 */

import { JournalConflictError, type JournalStore } from "./workflow-journal-types.ts";

/**
 * What a wrapped journal reports back, and how the walk reads it.
 *
 * The `failure` is held rather than merely thrown, for the reason `replayRun`'s
 * `refused` is: JavaScript `catch` catches everything, and one shipped template
 * wraps its whole body in a `try`. A body that swallowed a journal rejection
 * would otherwise carry on to an answer and the run would report `completed`
 * with a step it never managed to record — the quieter, worse half of the same
 * bug.
 */
export type JournalFailureWatch = {
  /** The journal to hand the walk. Every method reports through this watch. */
  readonly journal: JournalStore;
  /**
   * The first rejection any journal method produced, or `undefined`.
   *
   * FIRST rather than last: a store that has gone away rejects everything the
   * walk tries next, and the first failure is the one with a cause worth
   * reading. It is re-thrown as it arrived, so the caller sees the store's own
   * error rather than a wrapper's paraphrase.
   */
  failure: () => unknown | undefined;
};

/**
 * Wrap `journal` so any rejection is recorded on this walk and re-thrown.
 *
 * @internal
 */
export function watchJournalFailure(journal: JournalStore): JournalFailureWatch {
  let failure: unknown | undefined;
  let failed = false;

  /**
   * Record and re-throw.
   *
   * A separate `failed` flag rather than testing `failure !== undefined`,
   * because a store may reject with `undefined` — rare, and the alternative is a
   * walk that fails invisibly, which is the whole class of bug this closes.
   */
  const note = (err: unknown): never => {
    // A CONFLICT is not the store failing — it is the store refusing this run on
    // its own merits, and it cannot change however often the delivery is
    // retried. So it passes through untouched and reaches `classifyThrow` as an
    // ordinary throw, which fails the run and reports the refusal. Getting this
    // wrong is not theoretical: without the exemption
    // `workflow-engine-waits.test.ts`'s "fails a run whose token another LIVE
    // run already holds" stops failing the run and the delivery is retried
    // forever. `JournalConflictError` carries the argument and why the set is
    // closed at one member.
    if (JournalConflictError.is(err)) throw err;
    if (!failed) {
      failed = true;
      failure = err;
    }
    throw err;
  };

  /**
   * `resumableRuns` is OPTIONAL on the interface and its absence is a
   * DECLARATION — `isResumableJournal` narrows on it — so a wrapper that
   * unconditionally defined it would tell the boot sweep a backend can enumerate
   * runs when it cannot. Spread conditionally, never assigned.
   */
  const sweep = journal.resumableRuns;

  return {
    failure: () => (failed ? failure : undefined),
    journal: {
      createRun: (record) => journal.createRun(record).catch(note),
      getRun: (runId) => journal.getRun(runId).catch(note),
      listRuns: (workflow, limit) => journal.listRuns(workflow, limit).catch(note),
      setStatus: (runId, next, patch, expect) =>
        journal.setStatus(runId, next, patch, expect).catch(note),
      readSteps: (runId) => journal.readSteps(runId).catch(note),
      readStep: (runId, key) => journal.readStep(runId, key).catch(note),
      claimAttempt: (runId, key) => journal.claimAttempt(runId, key).catch(note),
      releaseAttempt: (runId, key) => journal.releaseAttempt(runId, key).catch(note),
      claimSleep: (runId, key, wakeAt, correlationId, kind) =>
        journal.claimSleep(runId, key, wakeAt, correlationId, kind).catch(note),
      wakeSleeps: (runId, ids) => journal.wakeSleeps(runId, ids).catch(note),
      claimHook: (runId, key, token) => journal.claimHook(runId, key, token).catch(note),
      closeHook: (runId, key) => journal.closeHook(runId, key).catch(note),
      deliverHook: (token, payload) => journal.deliverHook(token, payload).catch(note),
      appendStep: (runId, entry) => journal.appendStep(runId, entry).catch(note),
      ...(sweep === undefined
        ? {}
        : { resumableRuns: (limit: number) => sweep(limit).catch(note) }),
    },
  };
}
