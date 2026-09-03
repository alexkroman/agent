// Copyright 2026 the AAI authors. MIT license.
/**
 * A step's attempt CHARGE: take one, or refuse the walk.
 *
 * Split from `workflow-replay-step.ts` at the seam that module's doc already
 * drew — *"everything here is a fact about the journal's charge, where
 * everything left there is the retry policy"* — when the stale-snapshot read
 * below pushed it past the 500-line cap. Read that module first: its "An
 * attempt is a LEASE" section is the statement of the invariant, and
 * `packages/aai-runtime/CLAUDE.md` carries the account.
 *
 * Two things happen here and they are ordered on purpose. A settled step is
 * answered from the journal, and only then is the budget consulted — because a
 * step that has SETTLED is not a step to refuse.
 *
 * @module
 */

import type { StepEntry } from "./workflow-journal-types.ts";
import type { StepAttemptOptions } from "./workflow-replay-step.ts";

/**
 * A step whose attempt budget is spent by attempts that never ENDED.
 *
 * Its own class, and not a `FatalError`, for the reason `ReplayDivergenceError`
 * is not one: this is a verdict about the WALK, not about the step. Nothing
 * failed — one or more workers died holding an attempt of this step — so there
 * is nothing to journal, and a `failed` entry written here would be
 * authoritative forever over a step that may well have succeeded on the walk
 * running beside this one. That entry is the defect this class exists to
 * replace; see "An attempt is a lease" above.
 *
 * Deliberately not exported from the package, and deliberately not catchable in
 * any useful sense: a body may still `catch` it, and `replayRun` records it
 * anyway, because the only correct responses are to fix whatever is killing the
 * worker or to drain the run.
 */
export class StepAbandonedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepAbandonedError";
  }
}

/**
 * What to say when a step's whole budget is held by attempts that never ended.
 *
 * Names the two causes rather than the symptom, because they want opposite
 * fixes and the number alone reads as a step that failed — which it is not.
 */
function abandonedMessage(name: string, outstanding: number, maxAttempts: number): string {
  return (
    `step ${name} has ${outstanding} unfinished attempt(s) against a budget of ` +
    `${maxAttempts}: a worker died mid-step, or this run is being delivered more ` +
    "times at once than the budget allows"
  );
}

/**
 * Has this key been SETTLED since the walk took its snapshot?
 *
 * `replayRun` reads the journal ONCE per walk — `JournalStore`'s doc argues why,
 * and that argument is sound for the cost it is about. What it does not bound is
 * how long that snapshot is TRUSTED, and a walk can live a very long time: an
 * overlapping delivery starts with an empty snapshot and then reaches step after
 * step, answering each from a picture of the run taken before any of them
 * existed.
 *
 * Observed on a deployed transcription workflow, from the server log: the
 * platform's delivery ceiling closed one delivery's HTTP response at 60 s but
 * did not stop its walk, so a second walk started 61 s in with an empty
 * snapshot. Walk 1 went on to complete the whole run. Walk 2 then re-executed
 * `normalizeRecording`, `splitRecording`, four `transcribeSegment` calls and
 * `mergeTranscript` — **against the real provider, on a run already marked
 * `completed`**. `appendStep` is idempotent, so the ANSWER was still walk 1's
 * and nothing diverged; what doubled was the money.
 *
 * **The read is on `outstanding > 1` and nowhere else.** A snapshot can only be
 * stale about a key somebody ELSE reached, and `claimAttempt`'s answer is
 * exactly that fact: `1` means this attempt is the only one outstanding, so
 * nothing else has touched the key and there is nothing to have missed. So the
 * happy path — a first walk reaching a fresh step — pays nothing at all, and the
 * extra round trip lands only where it can change the outcome: a step reached by
 * an overlapping walk, or by one that died.
 *
 * **It is `readStep` and not `readSteps`.** This asks about ONE key, and it used
 * to read the whole journal and keep one entry — an O(N) scan to answer an O(1)
 * question, on the contended path, in exactly the runs where N is largest. That
 * does not contradict the once-per-walk argument above, which is about the
 * WALK's opening read; see `JournalStore.readStep`.
 *
 * **What it does NOT fix, deliberately**: two walks reaching a step NEITHER has
 * settled still both run it. That is the engine's stated at-least-once cost
 * (`workflow-engine.ts`: *"not doing the work twice … is a cost rather than a
 * correctness problem"*), measured by `Stats.duplicateSteps` rather than
 * forbidden, and closing it needs a lease with an EXPIRY — a heartbeat. What
 * this closes is the half that is not a race at all: a window measured in
 * minutes, in which every step of a FINISHED run is re-executed.
 */
function settledSince(options: StepAttemptOptions): Promise<StepEntry | undefined> {
  return options.journal.readStep(options.runId, options.key);
}

/**
 * Charge one attempt, or REFUSE the walk.
 *
 * Its own function because the loop below was measured at cognitive complexity
 * 18, and this is the half with no `tries` in it: everything here is a fact
 * about the journal's charge, where everything left there is the retry policy.
 */
export async function chargeAttempt(options: StepAttemptOptions): Promise<StepEntry | undefined> {
  const { runId, name, key, maxAttempts, journal } = options;
  // Before the body, never after — see `JournalStore.claimAttempt`. What comes
  // back is how many attempts are OUTSTANDING, this one included.
  const outstanding = await journal.claimAttempt(runId, key);
  // `1` means nothing is outstanding but this attempt — so no earlier walk is
  // holding one and none was ever abandoned here. Outside the caller's try, so
  // a refusal escapes unretried and unjournaled — see `onFirstReach`.
  if (outstanding === 1) {
    options.onFirstReach?.();
    return undefined;
  }
  // Anything ELSE means somebody else reached this key: a walk running beside
  // this one, or one that died holding an attempt. That is the only condition
  // under which the walk's `readSteps` snapshot can be stale about THIS key, so
  // it is the only condition under which a re-read is worth a round trip — see
  // {@link settledSince}. BEFORE the budget check below, because a step that
  // has SETTLED is not a step to refuse: the answer exists.
  const settled = await settledSince(options);
  // The walk has to be TOLD, or the divergence check reads the skipped children
  // of a nested step as displaced work — see `DivergenceWatch.answeredLate`.
  if (settled) options.onAnsweredLate?.(settled);
  // The charge is deliberately NOT given back, unlike the refusal below.
  // `claimAttempt` answering `1` is what the divergence check reads as "no
  // earlier walk ever REACHED this key" (`workflow-replay-divergence.ts`, "two
  // facts decide it"), and a release here erases that record — a later walk
  // whose own snapshot is stale about the same key then sees `1`, fires
  // `onFirstReach`, and a healthy run is refused as a divergence. Found by the
  // concurrent-delivery property, which failed with the renamed-step message on
  // a run nobody had renamed. Nothing accumulates: a charge left on a SETTLED
  // key is only ever re-read by another stale walk, which reaches this branch
  // and answers from the entry before the budget check below can refuse it.
  if (settled) return settled;
  if (outstanding <= maxAttempts) return undefined;
  // This attempt ends here, in a refusal, so its charge goes back like any
  // other — which also keeps the refusal STABLE: the next reach re-takes the
  // same number and is refused for the same reason.
  await journal.releaseAttempt(runId, key);
  const message = abandonedMessage(name, outstanding - 1, maxAttempts);
  options.onAbandoned?.(message);
  // NOT journaled. See {@link StepAbandonedError}: nothing failed, and the walk
  // running beside this one may be about to succeed.
  throw new StepAbandonedError(message);
}
