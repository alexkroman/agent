// Copyright 2026 the AAI authors. MIT license.
/**
 * Did this walk go somewhere the run has never been, while work it HAS done is
 * still unread?
 *
 * Split from `workflow-replay.ts` at the seam that file already had. The walk
 * decides IDENTITY and ATTEMPTS elsewhere; this decides one thing only — whether
 * a key nobody ever reached is ordinary new progress or a body that has lost its
 * place — and keeping it here is what took `workflow-replay.ts` back under the
 * 500-line cap.
 *
 * ## The defect this exists for, measured
 *
 * `(name, occurrence)` is computed DURING the walk, so a body-level
 * non-determinism that reaches a step name mints a key the journal has never
 * seen — and an unseen key used to mean "run it". On a body one line long:
 *
 * `no-check`: a reproduction of the DEFECT, not a teaching example — `ctx`
 * and `charge` are the reader's, and the two lines are the whole point.
 * Scaffolding it into a compiling body would bury the one thing it shows.
 * ```ts no-check
 * const coin = Math.random() < 0.5 ? "h" : "t";
 * await ctx.step(`charge-${coin}`, charge);
 * await ctx.sleep(1000); // suspends; the next delivery re-walks the body
 * ```
 *
 * **7 of 10 runs executed the side effect twice, and all 10 reported
 * `completed`** with a clean journal and no log line. Substitute "charge the
 * customer" for the side effect and that is the whole bug. It is also the
 * promise `sdk/map-concurrent.ts` documented for a year before anything kept it.
 *
 * ## Two facts decide it, and neither alone is enough
 *
 * - **`claimAttempt` answers `1`** — no earlier walk ever REACHED this key. This
 *   is the half that makes the check precise rather than merely suspicious. A
 *   crash mid-fan-out leaves the journal with GAPS (`segment#1` settled,
 *   `segment#0` still in flight), so "unseen" on its own is a legitimate resume
 *   at least as often as it is a fault. A step that was reached and lost has an
 *   attempt on the record; one the body has never issued has none. The counter
 *   is claimed on a round trip the engine was making anyway, so this costs
 *   nothing. That half lives in `workflow-replay-attempt.ts`, at the claim.
 * - **The journal holds a skipped entry that nothing this walk read can
 *   explain** — {@link DivergenceWatch.reach} below.
 *
 * ## What it does NOT cover
 *
 * Identity that comes from a COUNTER rather than a name. `sleep!${n}` and
 * `hook!${n}` are positional, so a body reaching a different NUMBER of waits
 * reads another wait's record and nothing here sees it. Closing that needs
 * `claimSleep`/`claimHook` to report whether the key was NEW, which is a
 * `JournalStore` change across all four backends rather than a change here.
 *
 * A reordering UNDER ONE NAME is likewise invisible, and deliberately so:
 * `mapConcurrent` names every call in a fan-out the same, so a changed item
 * order reads another item's journaled result with every key still matching.
 * `sdk/map-concurrent.ts` owns that rule and states it in place.
 */

import type { StepEntry } from "./workflow-journal-types.ts";

/**
 * The walk went somewhere the run has never been while work it HAS done is still
 * unread — so the engine refused to execute rather than executing a side effect
 * a second time.
 *
 * A `FatalError` would be wrong: this is not a verdict about the step, and a
 * retry cannot change it. Its own class so `replayRun` can tell it from whatever
 * a body throws, and so a body that catches broadly cannot turn a refusal into a
 * `failed` message blaming the step.
 *
 * Deliberately NOT exported from the package. A body must not branch on it — the
 * only correct response is to fix the body or drain the run — and catching it is
 * already handled: `replayRun` records the divergence even when the body
 * swallows the throw.
 */
export class ReplayDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayDivergenceError";
  }
}

/**
 * What to say when a walk minted a key the run has never reached.
 *
 * **Names BOTH keys, because that is the whole diagnosis.** The engine cannot
 * tell a renamed step from a computed one — determinism is a fact about how a
 * value was PRODUCED, and a journal holds only what it was — but the reader can,
 * in one look at their own source, and the two causes want opposite fixes. So
 * the message states the pair and hands over the test rather than guessing.
 */
function divergedMessage(key: string, name: string, displaced: string, remaining: number): string {
  return (
    `Workflow replay diverged: this walk reached step "${name}" as journal key ` +
    `${key}, which no earlier walk ever reached, while ${remaining} journaled ` +
    `step(s) remain unread — the first being ${displaced}. The engine refused to ` +
    "execute it, because an unreached key means an unjournaled execution and " +
    "that is how a side effect runs twice.\n" +
    `Two causes, and they want different fixes. If both "${name}" and the name in ` +
    `${displaced} appear as string LITERALS in this workflow, the CODE changed ` +
    "while this run was in flight (a step renamed, inserted or removed): runs " +
    "started against the old body cannot be resumed against the new one, so " +
    `drain them before deploying, or let them fail. If "${name}" does not appear ` +
    "as a literal, the name was COMPUTED and the BODY is non-deterministic — a " +
    "clock, a random number, a uuid or a network read ran outside a ctx.step and " +
    "answered differently on this walk. Move it inside a step and use the " +
    "journaled value."
  );
}

/** One walk's view of what it has read out of the journal. */
export type DivergenceWatch = {
  /**
   * Record that the walk has reached `key`, and say whether reaching it looks
   * like divergence.
   *
   * Call it for EVERY step, answered or not, and call it at identity time —
   * synchronously, before any `await`. A fan-out issues its keys synchronously
   * and settles them in any order, so a sibling recorded a microtask later would
   * drain the set out from under this check and hide a real divergence.
   *
   * Answers the refusal to throw when the key turns out never to have been
   * claimed, or `undefined` when there is nothing to suspect.
   */
  reach(
    key: string,
    name: string,
    answered: StepEntry | undefined,
  ): ReplayDivergenceError | undefined;
  /**
   * Record that a key this walk reached UNANSWERED turned out to be settled
   * after all, so its journaled entry counts as read.
   *
   * The walk's snapshot is one read, and `workflow-replay-attempt.ts` takes a
   * second one when the charge says another walk touched the key — so a step
   * can be answered from the journal without ever having been in `entries`.
   * That is indistinguishable from an EXECUTION to {@link reach}, which is
   * handed the snapshot's answer, and the difference is load-bearing: the
   * `readThrough` cursor below is what excuses a nested step's children, and a
   * parent answered on this path used to leave its children displaced. Measured
   * — the concurrent-delivery property refused `[outer(inner), …]` with the
   * renamed-step message on a run nobody had renamed.
   *
   * A refusal already computed for an EARLIER key is not revisited, which is a
   * MISS rather than a false accusation and is the direction this whole check
   * errs in. It is only reachable for a fan-out, whose siblings all reach
   * synchronously before any of them settles.
   */
  answeredLate(entry: StepEntry): void;
};

/**
 * Watch one walk against the steps the journal already held.
 *
 * `entries` is the initial `readSteps`, and nothing appended during this walk
 * joins it — which is what makes "the journal still holds work" a statement
 * about the PREVIOUS walk rather than about this one, and why a FIRST execution
 * cannot false-positive: its journal is empty, so every call answers `undefined`.
 */
export function watchDivergence(entries: readonly StepEntry[]): DivergenceWatch {
  const unread = [...entries];
  const unreadKeys = new Set(unread.map((entry) => entry.key));
  /** The latest `finishedAt` among the entries this walk has ANSWERED, or -1. */
  let readThrough = -1;

  /**
   * A journaled step this walk has skipped that CANNOT be explained by a step it
   * answered — or `undefined`, meaning nothing here is evidence of divergence.
   *
   * **The `finishedAt` test is not a heuristic, it is what makes the check sound.**
   * A body may nest — `ctx.step("outer", () => ctx.step("inner", …))` is legal,
   * and `_workflow-resume-harness.ts` generates it — and on a replay the OUTER
   * answer short-circuits the callback, so the inner key is journaled, never
   * re-read, and sits in this set forever. Every later first-reached step would
   * then read as divergence, which is a resumable run turned into a failed one:
   * measured, `[outer(inner), step, sleep]` and `[outer(inner), waitStep, loop]`
   * both failed the resume-equivalence property against the naive form of this
   * check, on an ordinary crash and with no author mistake anywhere in them.
   *
   * A parent settles at or AFTER its children, always — it is still running while
   * they finish. So an entry that finished STRICTLY LATER than everything this
   * walk has answered cannot be a descendant of any of them, and is the only kind
   * of skip this will act on. What that costs is a MISS when the displaced step
   * settled inside the same millisecond as the last answered one (in-memory steps
   * in a spec) or out of order (a fan-out settles by completion, not by issue) — a
   * miss, never a false accusation, which is the right direction for a check whose
   * remedy is failing the run.
   */
  const displaced = (): StepEntry | undefined =>
    unread.find((entry) => unreadKeys.has(entry.key) && entry.finishedAt > readThrough);

  return {
    reach(key, name, answered) {
      unreadKeys.delete(key);
      if (answered !== undefined) {
        readThrough = Math.max(readThrough, answered.finishedAt);
        return;
      }
      const skipped = displaced();
      if (skipped === undefined) return;
      return new ReplayDivergenceError(divergedMessage(key, name, skipped.key, unreadKeys.size));
    },
    answeredLate(entry) {
      readThrough = Math.max(readThrough, entry.finishedAt);
    },
  };
}
