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
 * await ctx.sleep("settle", 1000); // suspends; the next delivery re-walks the body
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
 * **The WAITS used to be the headline gap here, and they are not any more.**
 * `sleep!${n}` and `hook!${n}` were positional, so a body reaching a different
 * NUMBER of waits read another wait's record and nothing here saw it — measured
 * at a week-long `ctx.sleep` skipped in full with the run reporting `completed`
 * (`workflow-replay-wait.ts` has that transcript). This section used to say that
 * closing it needed `claimSleep`/`claimHook` to report whether the key was NEW,
 * i.e. a `JournalStore` change across all four backends. It did not: the keys
 * are `sleep!${label}#${occurrence}` and `hook!${token}#${occurrence}` now, so a
 * wait that moves keeps its own record and the whole class is unrepresentable.
 * `ctx.sleep` grew a `label` for it; `ctx.waitFor`'s token was already a name.
 *
 * What is left of it is one shape, and it is strictly better than what it
 * replaced: a label or token that is ITSELF non-deterministic mints a key no
 * walk has reached, so the run registers a fresh wait and PARKS on something
 * nobody can signal. That hangs rather than answering wrongly. Nothing detects
 * it — {@link waitTokenDiverged} is the nearest thing and cannot fire on a key
 * that names its own token — and detecting it really would need the NEW-key
 * report this paragraph used to ask for. It is not built, because a hang is
 * visible in a way a wrong payload was not.
 *
 * The three determinism reads (`now!${n}`, `random!${n}`, `uuid!${n}`) are still
 * positional, deliberately: they take no argument to name, and they journal
 * through `appendStep`, so a reach is at least RECORDED here rather than
 * invisible. `sdk/workflow-ctx.ts` carries why naming them is a worse trade.
 *
 * A reordering UNDER ONE NAME is likewise invisible, and deliberately so:
 * `mapConcurrent` names every call in a fan-out the same, so a changed item
 * order reads another item's journaled result with every key still matching.
 * `sdk/map-concurrent.ts` owns that rule and states it in place.
 */

import type { CodeChange } from "./workflow-code-version.ts";
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
 * The second half of the diagnosis: which of the two causes the RUN RECORD rules
 * out.
 *
 * `divergedMessage` below names both keys and then hands the reader a test to
 * run against their own source, because the engine cannot tell a renamed step
 * from a computed one — determinism is a fact about how a value was PRODUCED and
 * a journal holds only what it was. What the record CAN settle is whether the
 * code moved at all, and each of the three answers is worth a different
 * sentence: `changed` states the redeploy and names both bundles, `same`
 * eliminates it and leaves non-determinism as the only remaining cause, and
 * `unknown` says nothing — which is the honest answer for a run started before
 * the field existed, or walked by a server with no bundle hash, and is why
 * `describeCodeChange` answers a verdict rather than a boolean.
 */
function codeSentence(code: CodeChange): string {
  if (code.kind === "changed") {
    return (
      "\nThe run record settles which cause this is: this run STARTED against " +
      `bundle ${code.startedUnder} and is being walked by ${code.current}, so ` +
      "the code changed while it was in flight. Drain in-flight runs before " +
      "deploying a change to a workflow body, or let them fail."
    );
  }
  if (code.kind === "same") {
    return (
      "\nThe run record RULES OUT a redeploy: this run started against bundle " +
      `${code.version} and is being walked by the same one, so the body itself ` +
      "is non-deterministic. Look for the computed name."
    );
  }
  return (
    "\nThe run record cannot say which cause this is — it carries no code " +
    "version (a run started before the field existed, or a server with no " +
    "bundle hash, such as `aai dev`)."
  );
}

/**
 * What to say when a walk minted a key the run has never reached.
 *
 * **Names BOTH keys, because that is the whole diagnosis.** The engine cannot
 * tell a renamed step from a computed one — determinism is a fact about how a
 * value was PRODUCED, and a journal holds only what it was — but the reader can,
 * in one look at their own source, and the two causes want opposite fixes. So
 * the message states the pair and hands over the test rather than guessing.
 *
 * The guess is NARROWER than it was: {@link codeSentence} appends what the run
 * record knows about the code, which eliminates one of the two causes whenever
 * the version is recorded on both sides. The two-cause fork stays in the text
 * regardless, because it is what tells the reader what to look FOR.
 */
function divergedMessage(
  key: string,
  name: string,
  displaced: string,
  remaining: number,
  code: CodeChange,
): string {
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
    "journaled value." +
    codeSentence(code)
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
export function watchDivergence(
  entries: readonly StepEntry[],
  // The default is the UNKNOWN verdict rather than a read of the environment: a
  // caller that has no run record — a spec driving a body, a harness — must get
  // silence about the code, never a comparison against a version it never
  // recorded. `replayRun` is the one production caller and it always passes one.
  code: CodeChange = { kind: "unknown" },
): DivergenceWatch {
  const unreadKeys = new Set(entries.map((entry) => entry.key));
  /** The latest `finishedAt` among the entries this walk has ANSWERED, or -1. */
  let readThrough = -1;
  /**
   * How far into `entries` the scan below has ruled out FOR GOOD — a CURSOR,
   * where {@link displaced} used to be a `find` over the whole journal.
   *
   * The two things that disqualify an entry are both one-directional — a key
   * leaves `unreadKeys` and never returns, and `readThrough` only ever advances
   * (`Math.max`) — so every entry the scan steps over is disqualified
   * permanently and no later call has to look at it again. A walk therefore
   * pays O(N) advances in total plus O(1) per call, where the `find` cost
   * O(steps journaled) per step EXECUTED: O(N x M), on exactly the shape where
   * both terms are largest, a long fan-out resuming late. The 60-segment
   * transcription body is ~120 entries by its final delivery, and
   * `WORKFLOW_JOURNAL_MAX_STEPS` is the real ceiling.
   *
   * Measured, in milliseconds for a walk that answers N journaled steps and
   * then reaches M fresh keys (this scan alone, no engine around it):
   *
   * | N journaled | M fresh | `find` | cursor |
   * | --- | --- | --- | --- |
   * | 120 | 60 | 0.109 | 0.054 |
   * | 500 | 200 | 0.476 | 0.096 |
   * | 2000 | 500 | 4.03 | 0.55 |
   * | 10000 | 2000 | 74.1 | 5.02 |
   */
  let ruledOut = 0;

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
  const displaced = (): StepEntry | undefined => {
    // Scanned from {@link ruledOut}, which its own doc argues. What this
    // ANSWERS is unchanged either way: entries are visited in journal order and
    // the first qualifying one is the answer, because everything the cursor has
    // stepped over could never qualify again.
    for (; ruledOut < entries.length; ruledOut++) {
      const entry = entries[ruledOut];
      if (entry === undefined) continue;
      if (unreadKeys.has(entry.key) && entry.finishedAt > readThrough) return entry;
    }
    return undefined;
  };

  return {
    reach(key, name, answered) {
      unreadKeys.delete(key);
      if (answered !== undefined) {
        readThrough = Math.max(readThrough, answered.finishedAt);
        return;
      }
      const skipped = displaced();
      if (skipped === undefined) return;
      return new ReplayDivergenceError(
        divergedMessage(key, name, skipped.key, unreadKeys.size, code),
      );
    },
    answeredLate(entry) {
      readThrough = Math.max(readThrough, entry.finishedAt);
    },
  };
}

/**
 * What to say when a wait read a record that belongs to a DIFFERENT wait.
 *
 * `claimHook` is idempotent on its key, so what comes back on a replay is
 * whatever the first walk registered there — and the token on that record is the
 * one thing in the answer that identifies which `ctx.waitFor` really wrote it.
 * A mismatch is therefore not a suspicion the way an unreached step key is: it
 * is the journal stating that this walk is reading somebody else's answer.
 *
 * **Names both tokens, because the pair is the diagnosis.** The reader has to
 * see which wait they asked for and which one the run had journaled in that slot
 * — the two names are usually recognisable on sight in their own source, where
 * the key alone (`hook!0`) says nothing at all.
 */
function waitDivergedMessage(key: string, reached: string, stored: string): string {
  return (
    `Workflow replay diverged: this walk reached ctx.waitFor(${JSON.stringify(reached)}) ` +
    `as journal key ${key}, but that key was registered by ` +
    `ctx.waitFor(${JSON.stringify(stored)}) — so this walk is reading another ` +
    "wait's record, and would be handed that wait's payload as its own answer.\n" +
    "The body reached a different NUMBER of waits than the walk that journaled " +
    "them: a wait behind a condition that answered differently, or a wait added, " +
    "removed or reordered while this run was in flight. Runs started against the " +
    "old body cannot be resumed against the new one — drain them before " +
    "deploying, or let them fail. If neither is true, the condition guarding a " +
    "wait is non-deterministic: move whatever it reads inside a ctx.step, or use " +
    "ctx.now/ctx.random/ctx.uuid."
  );
}

/**
 * The refusal for a wait whose journaled record carries a different token, or
 * `undefined` when the record is this wait's own.
 *
 * ## This is an assertion about the KEY SCHEME, not about the body
 *
 * A wait's key embeds its token (`hook!${token}#${occurrence}`), so a record
 * fetched under it can only ever carry that token, and this cannot fire — which
 * is exactly why it is worth keeping. Waits were POSITIONAL (`hook!0`) when this
 * check was written, and then it was the only thing standing between a body that
 * reached a different number of waits and being handed the wrong payload:
 *
 * `no-check`: the DEFECT, not a teaching example — `ctx` is the reader's and the
 * two lines are the whole point.
 * ```ts no-check
 * if (somethingAboutTheClock) await ctx.waitFor("late");
 * await ctx.waitFor("final"); // hook!1 on walk 1, hook!0 on walk 2
 * ```
 *
 * Naming the token in the key is what turned that from a wrong answer into two
 * different keys, and this is what says so out loud: if the scheme is ever
 * changed back — or changed to a key that does not determine the token — the
 * silent-wrong-payload failure comes back, and this refuses the run instead. It
 * costs one comparison on a call that already made a round trip.
 */
export function waitTokenDiverged(
  key: string,
  reached: string,
  stored: string,
): ReplayDivergenceError | undefined {
  if (stored === reached) return undefined;
  return new ReplayDivergenceError(waitDivergedMessage(key, reached, stored));
}
