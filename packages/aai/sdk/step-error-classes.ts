// Copyright 2026 the AAI authors. MIT license.
/**
 * The two errors a step throws to CLASSIFY its own failure, and the one thing
 * the engine reads off them.
 *
 * These were the Workflow DevKit's (`FatalError` / `RetryableError` from
 * `@workflow/errors`) and are now ours, for the reason every other piece of the
 * DevKit removal has: the engine that reads a verdict lives here, so the
 * vocabulary it reads has to as well. An engine in this repo consulting a third
 * party's error classes to decide whether to burn an attempt is a seam with
 * nothing on the far side of it.
 *
 * ## Two outcomes, and the default is the safe one
 *
 * - A **{@link FatalError}** fails the run on the spot. No further attempt is
 *   made, however many attempts `StepOptions.maxAttempts` allowed.
 * - A **{@link RetryableError}** consumes one attempt and schedules the next,
 *   at {@link RetryableError.retryAfter}.
 * - **Anything else** — a `TypeError`, a bare `throw "nope"` — is treated as
 *   retryable. That is deliberate and it is the safe direction: the alternative
 *   is silently disabling retries for every failure nobody thought to classify.
 *
 * ## `is` is a static, and it is not `instanceof`
 *
 * A guest bundle can hold two copies of this module — the agent's own import and
 * one reached through a template's dependency — and `instanceof` answers false
 * across them, which would silently downgrade a `FatalError` to "unclassified,
 * so retry": the exact failure the class exists to prevent, in the direction
 * that costs money. So membership is a BRAND, a non-enumerable symbol the
 * constructor sets and the static reads.
 *
 * Non-enumerable matters twice over: `JSON.stringify` of an error carrying it
 * stays clean, and the wire codec that journals a failure does not have to know
 * the brand exists.
 *
 * @module step-error-classes
 */

import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";

/**
 * The brand both classes carry.
 *
 * `Symbol.for`, not `Symbol()`, for exactly the duplicate-copy case above: a
 * registry symbol is the same value in every copy of this module, where a fresh
 * one per copy would reintroduce the problem the brand solves.
 */
const STEP_ERROR_BRAND: unique symbol = Symbol.for("aai.stepError");

/** The two values the brand may hold. */
type BrandKind = "fatal" | "retryable";

/** Attach the brand without putting it in `Object.keys` or `JSON.stringify`. */
function brand(target: object, kind: BrandKind): void {
  Object.defineProperty(target, STEP_ERROR_BRAND, {
    value: kind,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Read the brand off an unknown value, or `undefined` when it has none.
 *
 * The brand's VALUE is validated rather than trusted, which is not merely
 * defensive: `Symbol.for` is a registry lookup, so any code in the process can
 * mint the same symbol, and a property carrying a garbage value would otherwise
 * flow straight into a verdict. `Reflect.get` rather than a cast through the
 * `isRecord` narrowing, because a cast asserts the thing the check was supposed
 * to establish — the point `guard-invariants` rule 17 makes.
 */
function brandOf(value: unknown): BrandKind | undefined {
  if (!isRecord(value)) return undefined;
  const kind = Reflect.get(value, STEP_ERROR_BRAND);
  return kind === "fatal" || kind === "retryable" ? kind : undefined;
}

/**
 * A failure that another attempt cannot fix.
 *
 * Throwing one fails the RUN, not merely the step — a step whose remaining
 * attempts are pointless has nothing left to contribute. Reach for it where the
 * far side has already given a terminal answer: a `404` on a resource that was
 * deleted, a `422` on input that will be malformed on every attempt, a provider
 * saying the recording has no speech in it.
 *
 * @public
 */
export class FatalError extends Error {
  /**
   * Always `true`.
   *
   * A readable field rather than only the brand, because it is what shows up in
   * a journaled failure and in a log line — `fatal: true` in a run's history
   * answers "why did this stop after one attempt" without the reader knowing
   * this class exists.
   */
  readonly fatal = true;

  constructor(message: string, options?: { cause?: unknown }) {
    // Through `omitUndefined` for the reason `RetryableError` gives below, and
    // so the two classes handle an absent cause identically.
    super(message, omitUndefined({ cause: options?.cause }));
    this.name = "FatalError";
    brand(this, "fatal");
  }

  /** Is `value` a {@link FatalError}, including one from another copy of this module? */
  static is(value: unknown): value is FatalError {
    return brandOf(value) === "fatal";
  }
}

/** What {@link RetryableError} accepts for its delay. */
export type RetryableErrorOptions = {
  /**
   * When the next attempt may run: a delay in MILLISECONDS, or the absolute
   * `Date` the far side named.
   *
   * Defaults to {@link DEFAULT_RETRY_DELAY_MS} from now. The DevKit accepted a
   * duration STRING here too (`"5s"`) and this does not — a string delay is one
   * more parser to own and no call site in the repo passed one, every one of
   * them having a `Retry-After` header or nothing.
   */
  retryAfter?: number | Date;
  cause?: unknown;
};

/**
 * How long a {@link RetryableError} that names no delay waits.
 *
 * One second, which is what the DevKit's class defaulted to — kept so the
 * migration changes no timing it does not have to. It is not a considered
 * number, and a caller who has the far side's own `Retry-After` should pass it:
 * this SDK encourages fan-out, so N segments meet a rate limit together and a
 * second later all N ask again.
 *
 * @public
 */
export const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * A failure another attempt might survive, with an optional "not before".
 *
 * @public
 */
export class RetryableError extends Error {
  /**
   * When the next attempt may run. Always a `Date` — a number passed to the
   * constructor is resolved against the clock AT CONSTRUCTION, which is the
   * moment the caller meant.
   */
  readonly retryAfter: Date;

  constructor(message: string, options?: RetryableErrorOptions) {
    // `omitUndefined` rather than a hand-rolled presence ternary, which is this
    // repo's one spelling of an optional field and what `_step-verdict.ts`
    // already uses for this class's OTHER option one file over. `Error` reads
    // `cause` by presence, so an empty bag and `undefined` mean the same thing.
    super(message, omitUndefined({ cause: options?.cause }));
    this.name = "RetryableError";
    const at = options?.retryAfter;
    this.retryAfter =
      at instanceof Date ? at : new Date(Date.now() + (at ?? DEFAULT_RETRY_DELAY_MS));
    brand(this, "retryable");
  }

  /** Is `value` a {@link RetryableError}, including one from another copy of this module? */
  static is(value: unknown): value is RetryableError {
    return brandOf(value) === "retryable";
  }
}
