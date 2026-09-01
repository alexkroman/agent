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
 * Nothing here knows about suspension. A step cannot wait: `ctx.sleep` and
 * `ctx.waitFor` belong to the body, which is what makes a step the unit this
 * engine can neither interrupt nor un-journal.
 */

import { sleep } from "@alexkroman1/aai/host-internal";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { JournalStore, StepEntry } from "./workflow-journal-types.ts";
import { withStepContext } from "./workflow-run-context.ts";

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
 * DevKit's, which re-enqueued instead of waiting. It stops being a compromise in
 * Phase 2: once a body can suspend, a delay over this cap becomes a suspend and
 * the wait costs nothing.
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
  const { runId, name, key, maxAttempts, journal, signal, fn } = options;

  for (;;) {
    signal?.throwIfAborted();

    // Before the body, never after — see `JournalStore.claimAttempt`.
    const attempt = await journal.claimAttempt(runId, key);
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
      if (!(FatalError.is(err) || attempt >= maxAttempts)) {
        await sleep(retryDelay(err));
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
