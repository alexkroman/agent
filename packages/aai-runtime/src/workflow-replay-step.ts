// Copyright 2026 the AAI authors. MIT license.
/**
 * One STEP's attempts: claim, run, journal, and decide whether to try again.
 *
 * Split from `workflow-replay.ts` at the seam that file already had. The two
 * halves answer different questions and share only the journal: the replay walk
 * decides IDENTITY — which journal key is this call, and is it already settled —
 * where this decides ATTEMPTS. Keeping them together put both in one function
 * Biome measured at complexity 20, and pushed the file to the 500-line cap.
 *
 * **A suspension cannot reach this loop at all, and there is no arm for one.**
 * That is true twice over now. A step cannot wait: `ctx.sleep` and `ctx.waitFor`
 * belong to the body and both REFUSE when reached inside a step — the closure a
 * step is handed CAPTURES `ctx`, so `ctx.step("waiting", () => ctx.sleep("nap", 60_000))`
 * was one line away at every call site, and `workflow-replay-wait.ts` carries the
 * check and the two bugs it ends. And a body-level wait no longer THROWS: it
 * parks on a promise that never settles and the walk suspends out of band
 * (`workflow-replay-suspend.ts`), so there is no signal to unwind through a step
 * even if one could be reached.
 *
 * This loop used to hold an arm for it — recognising the suspend, giving the
 * attempt charge back, and re-throwing untouched — because before the refusal a
 * suspend read as an ordinary retryable error and was JOURNALED
 * (`{status: "failed", error: "workflow suspended"}`), an entry authoritative
 * forever, so every later replay answered the wait as a failure. The arm is gone
 * with the throw that needed it; everything left here is the retry policy.
 *
 * ## An attempt is a LEASE, and there are two budgets rather than one
 *
 * `claimAttempt` was a tally, charged before the body and never given back, and
 * ONE number served two jobs that pull in opposite directions: how many times to
 * TRY (what an author writes `maxAttempts` for) and how many workers may DIE
 * holding this step. **`packages/aai-runtime/CLAUDE.md`, "An attempt is a LEASE,
 * not a tally", carries the whole account** — the property harness that shrank
 * the defect to a two-node body, the `failed` entry it appended over a step that
 * then succeeded, and the measurement showing the residual below is reachable.
 * What is here is the shape:
 *
 * - **Tries are counted LOCALLY**, in the walk, so two overlapping deliveries
 *   cannot spend each other's retries.
 * - **The charge is a LEASE over one REACH of the step**, taken before the body
 *   and given back only when the body SUSPENDS — the one outcome that settles
 *   nothing and yet is ordinary progress. A settled step never reads the charge
 *   again, and a walk that was killed cannot give one back, so the pre-body
 *   ceiling bounds ABANDONMENT, which is what it was written to bound.
 * - **The refusal is not a journal entry** ({@link StepAbandonedError}): only a
 *   walk whose own body threw may write a `failed` entry.
 *
 * The charge itself — `chargeAttempt`, the refusal, and the stale-snapshot read
 * that keeps a walk from re-running a step the journal has SETTLED — is in
 * `workflow-replay-attempt.ts`, split off at the seam this paragraph draws.
 *
 * **The residual, stated rather than hidden**: a charge cannot tell an abandoned
 * attempt from a LIVE one, so `maxAttempts` simultaneous in-flight deliveries of
 * one step is the most this tolerates — a fourth, with a budget of three, is
 * refused although nothing has died. Closing it needs a lease with an expiry,
 * i.e. a heartbeat. `settledSince` (in the module beside this one) is what keeps
 * the SETTLED half of it from re-running the work meanwhile.
 *
 * ## A `StepOptions.schema` is checked HERE, and that is the retryable half
 *
 * The check runs inside the attempt's `try` and BEFORE `appendStep`, so a value
 * the schema rejects is an ordinary attempt failure: nothing is journaled, the
 * backoff runs and is narrated, and a body that produced a bad shape once may
 * produce a good one next time — which is what an attempt is FOR, and why the
 * write side raises a plain error rather than a `FatalError`.
 *
 * Its counterpart on the READ side is deliberately not here, and it is not a step
 * failure at all: a step answered from the journal already SUCCEEDED, so
 * journaling `failed` over it would break the rule this module's own title
 * paragraph rests on. `workflow-replay-schema.ts` carries that argument and
 * `workflow-replay.ts` runs the arm.
 */

import { type StandardSchemaV1, sleep } from "@alexkroman1/aai/host-internal";
import { stepReport } from "@alexkroman1/aai/step";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import { errorMessage, isRecord } from "@alexkroman1/aai/utils";
import type { JournalStore, StepEntry } from "./workflow-journal-types.ts";
import { chargeAttempt, StepAbandonedError } from "./workflow-replay-attempt.ts";
import { checkedStepOutput } from "./workflow-replay-schema.ts";
import { withStepContext } from "./workflow-run-context.ts";
import type { StepGate } from "./workflow-step-gate.ts";

/**
 * The longest this will hold a worker waiting to retry a step.
 *
 * A `RetryableError` may name any delay — a rate limiter answering
 * `Retry-After: 300` is ordinary — and honouring it literally would park a
 * worker for five minutes on a run that is doing nothing. So a delay is CLAMPED
 * here, which means a long `retryAfter` is treated as a floor the engine
 * approximates rather than a promise it keeps.
 *
 * Stated plainly because it is the one place this engine is weaker than the
 * DevKit's, which re-enqueued instead of waiting — and it is still OPEN. The
 * machinery a fix would use exists (`journal.claimSleep` plus the suspension
 * channel in `workflow-replay-suspend.ts`): a delay over this cap should park
 * the walk instead, costing nothing. Nothing here does that yet — this clamps
 * and blocks.
 */
export const MAX_IN_PROCESS_RETRY_MS = 30_000;

// Re-exported: the class is DECLARED beside the charge that raises it, and this
// stays the module every reader (and `workflow-replay.ts`) already names.
export { StepAbandonedError } from "./workflow-replay-attempt.ts";

/**
 * A step that settled `failed`, as an error to throw into the body.
 *
 * Reconstructed rather than stored: an `Error` does not survive the journal's
 * codec as a class, only as its message. That loses the original's `cause` and
 * its stack, which is a real cost and the right trade — the alternative is
 * serialising arbitrary error subclasses, which cannot be done faithfully and
 * fails silently when it is done badly.
 *
 * It is a `FatalError` deliberately: by the time an entry exists the step is
 * OVER, so a body that re-throws it must not cause a fresh retry cycle
 * somewhere above.
 */
export function stepFailure(entry: StepEntry): Error {
  return new FatalError(entry.error?.message ?? `step ${entry.name} failed`);
}

/** How long to wait before a retryable step's next attempt, clamped. */
function retryDelay(err: unknown): number {
  const at = RetryableError.is(err) ? err.retryAfter.getTime() - Date.now() : 0;
  return Math.min(Math.max(at, 0), MAX_IN_PROCESS_RETRY_MS);
}

/**
 * A failure's own message, plus the message of whatever CAUSED it.
 *
 * The `cause` is the half nothing downstream keeps. {@link stepFailure} rebuilds
 * a failed step from `entry.error.message` alone — deliberately, since an
 * `Error` does not survive the journal's codec as a class — so a retry's chain
 * exists in exactly one place: the live value in this `catch`. Losing it costs
 * the sentence that explains the failure rather than merely naming it. The
 * shipped instance is the full scratch disk: `step-files.ts` wraps an `ENOSPC`
 * in a sentence carrying the path and the mount's capacity, and it is the
 * WRAPPER's message that is worth reading — but a wrapper that says only
 * "conversion failed" would leave the reader with nothing at all.
 *
 * NOT `errorDetail`, which is `message + stack`: a stack is the wrong artifact
 * for the two readers this line has (see {@link reportRetry}) — one is a page
 * that renders the line verbatim — and it would not have carried the chain
 * anyway, `Error.prototype.stack` in Node saying nothing about `cause`.
 *
 * One link deep. A chain of wrappers is a design problem, not a thing to print,
 * and the second link is where the useful specificity almost always is.
 */
function withCause(err: unknown): string {
  const message = errorMessage(err);
  const cause = isRecord(err) ? err.cause : undefined;
  if (cause === undefined) return message;
  const because = errorMessage(cause);
  // A wrapper that re-uses its cause's message (or embeds it, which is what
  // `${message}: ${cause}` composition produces) has nothing to add.
  return because === "" || message.includes(because)
    ? message
    : `${message} — caused by ${because}`;
}

/**
 * Narrate a failure that is about to be RETRIED, the one outcome this loop used
 * to discard entirely.
 *
 * Only the last attempt was recorded, and only as `error.message` on the
 * journal entry — so a step could fail three times with nothing anywhere saying
 * why: no entry, no log line, no narration. The whole visible output of four
 * failing attempts was the body's own progress line, repeated, with
 * `workflow-report.ts`'s `(attempt N)` suffix on it. That reads as "it keeps
 * converting", which is a slow step; the run was hitting a full disk in ~5.5 s
 * and retrying into it. Hours of the wrong hypothesis came out of that gap, and
 * the fix is one line per non-final failure.
 *
 * ## `stepReport()`, not a logger — and it is not the constraint that decided it
 *
 * `stepReport()` reaches BOTH readers, because `createStepReporter` writes the
 * server log line as well as the run's stream. So the choice is not "page or
 * operator": it is whether the page ALSO sees this, and it should.
 *
 * - The stream is the only channel that reaches the person waiting. A retry
 *   changes what they should expect — a longer wait, then possibly a failure —
 *   and "silently retrying" is precisely the state that read as "working".
 * - The repo has already decided that retries are page-worthy: the `(attempt N)`
 *   suffix exists so "a reader watching sixty segments" can tell a retrying
 *   fan-out from a healthy one. This says what that suffix could not — WHY.
 * - A step's final failure message already reaches the page through the run's
 *   `error`, so a non-final one is not a new class of disclosure; it is the same
 *   sentence, earlier, about an attempt that did not stick.
 *
 * A `logger.warn` would need a `Logger` threaded through `replayRun` and its
 * callers, and would reach only the operator — the reader who was NOT the one
 * misled here.
 *
 * Written as ONE self-contained sentence, and deliberately not inside
 * `withStepContext`: the `catch` is outside the step context by construction, so
 * the log line carries no `step`/`attempt` fields — the sentence names both
 * instead, which is what the stream reader gets either way, and it keeps the
 * reporter's own `(attempt N)` suffix from doubling up on a number the line
 * already states.
 *
 * `stepReport()` swallows its own failures and resolves either way, so awaiting it
 * cannot fail a step or lose an attempt.
 */
async function reportRetry(
  name: string,
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  err: unknown,
): Promise<void> {
  await stepReport(
    `Step ${name} failed on attempt ${attempt} of ${maxAttempts}, ` +
      `retrying in ${delayMs}ms: ${withCause(err)}`,
  );
}

/**
 * What {@link runStepAttempts} needs to settle one step.
 *
 * A bag rather than eight positional parameters, and it is the same set the
 * journal entry is built from — which is the point: an entry field added
 * without a way to fill it is a compile error here rather than a `undefined`
 * in a run's history.
 */
export type StepAttemptOptions = {
  runId: string;
  name: string;
  key: string;
  maxAttempts: number;
  journal: JournalStore;
  /**
   * This WALK's id, which is who holds the attempt charges it takes.
   *
   * One per `replayRun` rather than one per step, because the thing a charge
   * attributes is the walk: a walk that dies takes every charge it holds with
   * it, and a walk that reaches the same key twice must not pay twice. See
   * `JournalStore.claimAttempt`.
   */
  holder: string;
  signal: AbortSignal | undefined;
  /**
   * How many step bodies may execute at once in this process.
   *
   * Held across the WHOLE attempt loop rather than per attempt — see the call
   * site in `workflow-replay.ts` for why. Absent runs ungated, which is what a
   * spec wants and what no production caller passes.
   */
  gate: StepGate | undefined;
  /**
   * Called once, after the attempt is claimed and BEFORE the body runs, when
   * this key had never been claimed by any earlier walk.
   *
   * The attempt counter is the only record the journal keeps of a step that was
   * REACHED but never settled, and that distinction is what the caller's
   * divergence check turns on — see `replayRun`. So the fact is reported from
   * here, where `claimAttempt`'s answer is, and the POLICY stays with the walk
   * that knows what the journal still holds.
   *
   * **It may throw, and a throw refuses the execution.** Deliberately called
   * OUTSIDE the try below, so a refusal is neither retried nor journaled: it is
   * not a verdict about the step, it is a verdict about the walk that reached
   * it, and journaling `failed` here would make the refusal authoritative
   * forever — the same trap {@link attemptLoop} already avoids for a suspend.
   */
  onFirstReach?: (() => void) | undefined;
  /**
   * Called with the refusal's own message when the step's budget is spent,
   * immediately before {@link StepAbandonedError} is thrown.
   *
   * The caller's half of "a refusal is not a verdict": `replayRun` records the
   * message so a body that catches broadly cannot turn the engine's refusal into
   * a `completed`, exactly as it already does for a divergence. Recorded rather
   * than returned, because the throw has to unwind whatever depth the step was
   * reached at.
   */
  onAbandoned?: ((message: string) => void) | undefined;
  /**
   * Called with the journaled entry when this key turns out to have SETTLED
   * while the walk was elsewhere, so the step is answered rather than run.
   *
   * The walk's own business, exactly like {@link StepAttemptOptions.onFirstReach}
   * above: what the charge can see is that another walk touched the key, and
   * what to do about it — advance the divergence cursor, so a nested step's
   * children are not read as displaced — belongs to the walk that knows what its
   * journal held. See `DivergenceWatch.answeredLate`.
   */
  onAnsweredLate?: ((entry: StepEntry) => void) | undefined;
  /**
   * `StepOptions.schema`, when the body declared one.
   *
   * Checked against what the body RETURNS, before the entry is appended — the
   * write half of the pair the module doc argues. The read half is the caller's,
   * because only the caller knows whether an entry came from the journal.
   */
  schema?: StandardSchemaV1 | undefined;
  fn: () => unknown;
};

/**
 * Run one step until it settles, and journal the entry that settled it.
 *
 * Extracted from `ctx.step` rather than inlined, because the two do genuinely
 * different jobs: `ctx.step` decides IDENTITY (which journal key is this call?)
 * and answers from the journal, and this decides ATTEMPTS. Keeping them in one
 * function put both decisions in one 60-line closure that Biome measured at
 * complexity 20, and the split is what a reader wants anyway — the retry policy
 * is the part with the interesting invariants.
 *
 * Resolves the settling entry, `ok` or `failed`. Never throws for a step
 * failure: the caller turns the entry into the throw, so the journal write and
 * the throw cannot come apart.
 */
export async function runStepAttempts(options: StepAttemptOptions): Promise<StepEntry> {
  const gate = options.gate;
  return gate ? gate(() => attemptLoop(options)) : attemptLoop(options);
}

/**
 * Wait out a failed attempt's backoff.
 *
 * Journals nothing and touches no charge: this walk still holds the one it took
 * when it reached the step, and an in-process retry is not a second attempt as
 * far as the journal is concerned — see {@link attemptLoop}.
 */
async function backOff(options: StepAttemptOptions, tries: number, err: unknown): Promise<void> {
  const delayMs = retryDelay(err);
  // BEFORE the wait, not after it: a `retryAfter` of half a minute is ordinary
  // (see MAX_IN_PROCESS_RETRY_MS), and a line explaining the wait is worth
  // nothing once the wait is over.
  await reportRetry(options.name, tries, options.maxAttempts, delayMs, err);
  await sleep(delayMs);
}

async function attemptLoop(options: StepAttemptOptions): Promise<StepEntry> {
  const { runId, name, key, maxAttempts, journal, signal, fn } = options;

  /**
   * How many times THIS walk has run the body — the retry budget, and it is
   * deliberately local.
   *
   * It used to be the journal's charge, so a duplicate delivery spent from the
   * author's retry budget: `workflow-platform-dispatch.ts` records that cost in
   * so many words — *"it burns a second `claimAttempt` against the step's
   * ceiling, and a retry budget spent on our own duplicate is a step that fails
   * earlier than the author asked for"*. What `maxAttempts` means is how many
   * times to try, and how many workers happen to be trying is not that number.
   * The charge still bounds the case a local count cannot see — an attempt that
   * never ends; see {@link chargeAttempt}.
   */
  let tries = 0;

  /**
   * When this walk began working on the step, for the entry's `startedAt`.
   *
   * Taken here rather than in {@link runStepAttempts}, so it is AFTER the gate:
   * `finishedAt - startedAt` is then what the step itself cost — its own
   * attempts and their backoff — rather than that plus however long the process
   * was too busy to start it. Gate contention is real and worth seeing, and this
   * is not where it belongs: attributing it to the step would report a fast step
   * on a loaded worker as a slow step. It shows instead in the GAP between one
   * entry's `finishedAt` and the next's `startedAt`, which is the reading
   * `StepEntry.startedAt` documents as delivery latency.
   */
  const startedAt = Date.now();

  // ONE charge for the whole reach, taken before the body and given back only
  // if the reach ends in a durable WAIT. A retry below re-runs the body without
  // re-taking it, which is what makes the charge unbroken: every window in which
  // this walk could be killed is a window in which it holds one, so a death
  // always leaves the evidence a death is supposed to leave. Claiming per TRY
  // instead left a gap between the release and the next claim, and a kill
  // landing in it made the resume property fail — `all([flaky, step]), boom`
  // resumed to a divergence refusal on `s0#0`, the flaky step's own charge
  // having been handed back a moment before its walk died.
  signal?.throwIfAborted();
  // An entry back means the key settled while this walk was elsewhere, and the
  // body must not run: see {@link settledSince}.
  const already = await chargeAttempt(options);
  if (already) return already;

  for (;;) {
    signal?.throwIfAborted();
    tries++;
    try {
      // Inside the step's own context, so a `stepReport()` from the body or any
      // helper it calls is attributed to THIS step and this attempt — and so
      // that `stepFetch` can reach the WALK's signal without the body having to
      // thread one down to it. See `RunContext["step"].signal`.
      const produced = await withStepContext(
        { name, key, attempt: tries, maxAttempts, signal },
        async () => fn(),
      );
      // INSIDE the try and before the append, so a rejected value spends an
      // attempt and journals nothing — see the schema section of the module doc.
      // Awaited deliberately, unlike the append below: this throw is one this
      // loop MUST classify, where a journal rejection is one it must not.
      const output = await checkedStepOutput(options.schema, name, produced);
      // No release: the entry below is authoritative from now on, so every later
      // walk answers from `readSteps` and nothing reads the charge again. That
      // is what keeps the happy path at one journal round trip per step.
      //
      // `return`, NEVER `return await`, and that is load-bearing rather than a
      // style choice. A bare `return` inside a `try` hands the pending promise
      // out without settling it here, so the `catch` below cannot see it; add
      // `await` and a journal write that REJECTS becomes a value this loop
      // classifies as the step body's own failure — so it would either retry the
      // body (up to `maxAttempts`, re-running whatever the body was paid to do)
      // or journal `failed` over a step that SUCCEEDED, which is the one thing
      // "An attempt is a LEASE" says must never happen.
      //
      // Unawaited, the rejection propagates out of `replayRun` instead, which is
      // exactly the documented contract: a failure of the JOURNAL means the
      // run's state is unknown, so the delivery fails and is retried rather than
      // the run being marked failed on a database blip.
      //
      // The `catch`-swallows-a-`return` interaction is not hypothetical here.
      // The same shape, in the other direction, is why `deadlineOutcome` in
      // `workflow-replay-waits.ts` answers a descriptor rather than parking: a
      // bare `return` there ran the `finally` first and closed the slot the park
      // needed, and `replayRun` never returned.
      return journal.appendStep(runId, {
        key,
        name,
        status: "ok",
        output,
        attempts: tries,
        startedAt,
        finishedAt: Date.now(),
      });
    } catch (err: unknown) {
      // The WALK is over — a cancel, or the caller's own signal. This attempt
      // ends the way a DEATH ends one, and both halves of that are deliberate.
      //
      // Nothing is journaled: an abort is not a verdict about the step, and a
      // `failed` entry here would be authoritative forever over a run somebody
      // stopped — which is what the last attempt used to write, the loop having
      // read a cancellation as the step's own final failure.
      //
      // And the charge is NOT given back. A walk that was killed left this
      // attempt unfinished, so `claimAttempt`'s next answer must still say so:
      // that is the fact `workflow-replay-divergence.ts` exonerates a crashed
      // fan-out with, and releasing here made the resume property fail on its
      // sixth generated body — the outer step of a `nested` was refused as a key
      // "no earlier walk ever reached", one line after the walk that reached it
      // was killed inside it.
      //
      // `err === signal.reason` and not merely `signal.aborted`, which is the
      // same test `replayRun`'s `classifyThrow` makes and it is load-bearing in
      // both directions. A kill lands most often in a step's own `finally`, so
      // an attempt that had already decided — a `boom` that threw its
      // `FatalError` — must still journal that verdict, and the broader test
      // took `counts: {s0: 1}` to `{s0: 2}` on the resume property by throwing
      // the decision away.
      if (signal?.aborted && err === signal.reason) throw err;
      if (!(FatalError.is(err) || tries >= maxAttempts)) {
        await backOff(options, tries, err);
        continue;
      }
      // Unawaited for the reason the `ok` arm above is — though here it is the
      // weaker half of the same rule, this `return` being outside any `try`. It
      // stays unawaited so both arms read the same and neither invites the
      // `await` the other cannot afford.
      return journal.appendStep(runId, {
        key,
        name,
        status: "failed",
        error: { message: errorMessage(err) },
        attempts: tries,
        startedAt,
        finishedAt: Date.now(),
      });
    }
  }
}
