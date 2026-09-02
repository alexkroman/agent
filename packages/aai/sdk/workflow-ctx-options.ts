// Copyright 2026 the AAI authors. MIT license.
/**
 * The per-call OPTIONS a workflow body passes, and the one default it reads back.
 *
 * Split from `sdk/workflow-ctx.ts` along the seam `sdk/dialog-types.ts` and
 * `sdk/session-slot-types.ts` already use in this package — what a caller passes
 * IN, versus the handle it is given — when naming the durable waits took that
 * file past the 500-line cap. Every name here is re-exported from
 * `workflow-ctx.ts`, so an author still imports all of it from
 * `@alexkroman1/aai` and still finds it beside the method that takes it.
 *
 * @module
 */

/**
 * Per-step overrides. Everything here has a default that is right for most
 * steps; passing nothing is the common case.
 *
 * @public
 */
export type StepOptions = {
  /**
   * How many times to run this step before the run fails, counting the first
   * attempt.
   *
   * Only a `RetryableError` (or an unclassified throw) consumes an attempt — a
   * `FatalError` fails the run on the spot, which is the point of the
   * distinction. See `@alexkroman1/aai/step-errors`.
   *
   * Defaults to {@link DEFAULT_STEP_MAX_ATTEMPTS}. It is a per-step number
   * rather than a global because the right answer is a property of what the
   * step DOES: a model call worth retrying three times and a payment capture
   * worth retrying never are both ordinary.
   */
  maxAttempts?: number;
};

/**
 * Attempts a step gets when {@link StepOptions.maxAttempts} says nothing.
 *
 * Three, which is what the DevKit's queue hardcoded — kept deliberately so the
 * migration changes no retry behaviour it does not have to. Note attempts ARE
 * burned by failed boots, so a step can reach its ceiling without ever having
 * run its body; that was true before this change and is unchanged by it.
 *
 * @public
 */
export const DEFAULT_STEP_MAX_ATTEMPTS = 3;

/**
 * Per-wait options.
 *
 * @public
 */
export type WaitForOptions = {
  /**
   * How long to wait before giving up, in milliseconds.
   *
   * Resolves `undefined` when it elapses unanswered — not a throw, because a
   * window closing is an ordinary outcome a body branches on rather than a
   * failure. A signal that arrives after it is answered `false`, so a caller
   * cannot be told their answer was taken when it was not.
   */
  timeoutMs: number;
};

/**
 * Per-sleep options.
 *
 * @public
 */
export type SleepOptions = {
  /**
   * A name for this wait, so it can be ended early by name.
   *
   * Not required, and the default is deliberately the broad one: a `wake` naming
   * no ids ends every outstanding wait on the run. An id is what lets a run with
   * two concurrent waits — a review window and a retry backoff — have one of them
   * cut short without the other.
   */
  correlationId?: string;
};
