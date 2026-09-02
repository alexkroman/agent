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
 * A step cannot wait: `ctx.sleep` and `ctx.waitFor` belong to the body, which is
 * what makes a step the unit this engine can neither interrupt nor un-journal.
 * But the closure a step is handed CAPTURES `ctx`, so
 * `ctx.step("waiting", () => ctx.sleep(60_000))` is one line away at every call
 * site — which is why "nothing here knows about suspension" was the wrong reading
 * of that rule. The one thing this knows is that a suspend is NOT an attempt's
 * outcome: {@link attemptLoop} lets it out untouched, and everything else here is
 * the retry policy.
 */

import { isWorkflowSuspend } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/host-internal";
import { report } from "@alexkroman1/aai/step";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import { errorMessage, isRecord } from "@alexkroman1/aai/utils";
import type { JournalStore, StepEntry } from "./workflow-journal-types.ts";
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
 * DevKit's, which re-enqueued instead of waiting — and it is still OPEN. A body
 * can suspend now (`SuspendSignal`, `journal.claimSleep`), so the shape of the
 * fix exists: a delay over this cap should become a suspend, costing nothing.
 * Nothing here does that yet — this clamps and blocks.
 */
export const MAX_IN_PROCESS_RETRY_MS = 30_000;

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
 * ## `report()`, not a logger — and it is not the constraint that decided it
 *
 * `report()` reaches BOTH readers, because `createStepReporter` writes the
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
 * `report()` swallows its own failures and resolves either way, so awaiting it
 * cannot fail a step or lose an attempt.
 */
async function reportRetry(
  name: string,
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  err: unknown,
): Promise<void> {
  await report(
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

async function attemptLoop(options: StepAttemptOptions): Promise<StepEntry> {
  const { runId, name, key, maxAttempts, journal, signal, fn } = options;

  for (;;) {
    signal?.throwIfAborted();

    // Before the body, never after — see `JournalStore.claimAttempt`.
    const attempt = await journal.claimAttempt(runId, key);
    // `1` means no earlier walk ever reached this key. Outside the try, so a
    // refusal escapes unretried and unjournaled — see `onFirstReach`.
    if (attempt === 1) options.onFirstReach?.();
    if (attempt > maxAttempts) {
      return journal.appendStep(runId, {
        key,
        name,
        status: "failed",
        error: { message: `step ${name} exhausted ${maxAttempts} attempt(s)` },
        attempts: attempt - 1,
        finishedAt: Date.now(),
      });
    }

    try {
      // Inside the step's own context, so a `report()` from the body or any
      // helper it calls is attributed to THIS step and this attempt.
      const output = await withStepContext({ name, key, attempt }, async () => fn());
      return journal.appendStep(runId, {
        key,
        name,
        status: "ok",
        output,
        attempts: attempt,
        finishedAt: Date.now(),
      });
    } catch (err: unknown) {
      // A SUSPEND is not a verdict, so it is neither retried nor journaled.
      //
      // Out of contract and one line away anyway — the closure captures `ctx`.
      // Read as an ordinary retryable error it was catastrophic rather than
      // merely wrong: the body re-ran once per attempt, each run minting a
      // DISTINCT wait (`sleep!0/1/2`, the sleep counter advancing per re-walk, so
      // the wait's own identity diverged), the budget burned in one delivery, and
      // then `{status: "failed", error: "workflow suspended"}` appended — an
      // entry that is authoritative FOREVER, so every later replay answers the
      // wait as a failure. The run then failed with a `swallowedSuspend` message
      // blaming the body for a swallow the engine had performed.
      //
      // Re-thrown bare, the signal reaches `replayRun`'s own catch, which is the
      // one place that knows what to do with it.
      if (isWorkflowSuspend(err)) throw err;
      if (!(FatalError.is(err) || attempt >= maxAttempts)) {
        const delayMs = retryDelay(err);
        // BEFORE the wait, not after it: a `retryAfter` of half a minute is
        // ordinary (see MAX_IN_PROCESS_RETRY_MS), and a line explaining the
        // wait is worth nothing once the wait is over.
        await reportRetry(name, attempt, maxAttempts, delayMs, err);
        await sleep(delayMs);
        continue;
      }
      return journal.appendStep(runId, {
        key,
        name,
        status: "failed",
        error: { message: errorMessage(err) },
        attempts: attempt,
        finishedAt: Date.now(),
      });
    }
  }
}
