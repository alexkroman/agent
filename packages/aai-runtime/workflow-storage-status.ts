// Copyright 2026 the AAI authors. MIT license.
/**
 * Which HTTP status one Storage failure deserves, and how to read it back.
 *
 * Both directions of ONE taxonomy, in one file, because the two halves are only
 * correct with respect to each other: the platform picks a status for a world
 * error (`workflow-storage-handler.ts`, through `withReserved`'s `statusFor`
 * seam) and the guest turns that status back into the class the DevKit knows
 * (`workflow-platform-storage.ts`'s `storageFailure`). Split across the two
 * packages they drift silently — the platform starts answering 410 and the guest
 * keeps reading it as an unclassified failure, which is the shape of the bug this
 * module exists to fix, one status later.
 *
 * ## The bug: a permanent failure answered "retry me"
 *
 * `withReserved` defaults every unrecognised error to **503**, and that default is
 * right for what it was written for — from the guest's side a connection
 * shortage or a partitioned database really is transient, and the caller above is
 * built to retry. What it cannot see is that the DevKit's world raises PERMANENT
 * failures through the same path. The one that showed up in production:
 *
 * ```text
 *   RunExpiredError: Cannot modify non-running step on run in terminal state "failed"
 * ```
 *
 * A run in a terminal state never leaves it, so that call cannot succeed on any
 * retry, ever. Answered 503 it was retried until the budget ran out — per
 * abandoned step, on a run that had already failed. `withReserved`'s own doc
 * names this exact failure ("Re-wrapping one as a 503 tells the guest to retry a
 * request that can never succeed") and `statusFor` is the seam it provides; the
 * storage route simply never passed one.
 *
 * ## Only the PERMANENT classes are reclassified
 *
 * `ThrottleError` and `TooEarlyError` are also distinguishable here and are
 * deliberately left on the 503 default. They are transient, 503 already means
 * "retry me", and the only thing a 429/425 would add is the `retryAfter` the
 * caller should honour — which needs a `Retry-After` HEADER to survive the hop,
 * and `HTTPException` carries a status and a message, not headers. Worth doing;
 * not worth smuggling a number through an error string to do it. Until then a
 * throttle retries on the platform queue's own backoff, which is the behaviour
 * it has today.
 *
 * ## `.is()` rather than `instanceof`
 *
 * These classes are duck-typed by NAME through their own static guards, and that
 * is load-bearing rather than stylistic: this tree holds four copies of
 * `@workflow/errors` (its own, plus the ones bundled under `@workflow/builders`,
 * `@workflow/cli` and `@workflow/web`), and the copy that RAISED an error is the
 * one `world-postgres` resolved — not necessarily the one this module imported.
 * A prototype identity does not survive that, and neither does it survive the
 * guest's own two-copy seam (the harness bundles one, the agent bundle carries
 * another) — which is the reason `storageFailure` already reaches for
 * `WorkflowRunNotFoundError.is`.
 */

import { EntityConflictError, RunExpiredError } from "workflow/errors";

/**
 * A run that will not accept this write again — terminal, expired, or swept.
 *
 * **410 rather than 409**, because the two say different things to a retrying
 * caller and only one of them is true here: a conflict invites the caller to
 * re-read and try again, where `Gone` says the resource reached an end state and
 * no version of this request will land. That is exactly a terminal run.
 */
export const STORAGE_RUN_EXPIRED_STATUS = 410;

/**
 * A write that conflicts with the entity's current state.
 *
 * Distinct from {@link STORAGE_RUN_EXPIRED_STATUS} because the SUBJECT differs —
 * an entity rather than the run — and a caller can legitimately re-read and
 * decide, which is what 409 has always meant.
 */
export const STORAGE_CONFLICT_STATUS = 409;

/**
 * The statuses this taxonomy owns.
 *
 * A literal union rather than `number`, because the consumer builds a hono
 * `HTTPException` and that takes a `ContentfulStatusCode` — so a widened `number`
 * pushes a cast onto the call site for a value that is one of exactly two things.
 */
export type StorageRefusalStatus =
  | typeof STORAGE_RUN_EXPIRED_STATUS
  | typeof STORAGE_CONFLICT_STATUS;

/**
 * The status a Storage failure deserves, or `undefined` to leave it to the
 * caller's default.
 *
 * `undefined` is the important half of the contract: this classifies only what it
 * RECOGNISES, and everything else stays whatever `withReserved` decided. A
 * function that returned a status for every input would be silently deciding that
 * unknown failures are permanent, which is the opposite of the safe direction —
 * a transient failure misread as permanent strands a healthy run, where a
 * permanent one misread as transient only wastes retries.
 *
 * @internal
 */
export function storageStatusFor(err: unknown): StorageRefusalStatus | undefined {
  if (RunExpiredError.is(err)) return STORAGE_RUN_EXPIRED_STATUS;
  if (EntityConflictError.is(err)) return STORAGE_CONFLICT_STATUS;
  return undefined;
}

/**
 * The DevKit class a permanent status stands for, or `undefined` for a status
 * this taxonomy does not own.
 *
 * The inverse of {@link storageStatusFor}, and the reason the guest half is worth
 * writing at all: the DevKit's runtime handles `RunExpiredError` and
 * `EntityConflictError` itself — it stops, rather than retrying — and a plain
 * `Error` carrying the same text gets none of that handling. The status is the
 * only thing that crosses the wire, so this is where it becomes actionable again.
 *
 * @internal
 */
export function storageErrorForStatus(status: number, detail: string): Error | undefined {
  if (status === STORAGE_RUN_EXPIRED_STATUS) return new RunExpiredError(detail);
  if (status === STORAGE_CONFLICT_STATUS) return new EntityConflictError(detail);
  return undefined;
}
