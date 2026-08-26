// Copyright 2026 the AAI authors. MIT license.
/**
 * "A platform dependency we reach over HTTP is UNAVAILABLE" as a type, so the
 * HTTP surface can say 503 instead of 500.
 *
 * The third instance of one gap. `SandboxUnavailableError` closed it for spawns
 * and `PlatformDbUnavailableError` for the platform's Postgres pools; the two
 * dependencies this platform talks to over HTTP — Supabase Auth and Supabase
 * Storage — were still reaching `createErrorHandler` as bare `Error`s, logged
 * `unhandled error on <path>` and answered `500 Internal server error`.
 *
 * Both shipped, in one production hour:
 *
 * - `GET /studio/account` answered 500 six times on
 *   `Supabase auth verification failed (HTTP 500)`. GoTrue was returning 500
 *   because the instance had run out of connection slots, so the platform was
 *   telling a signed-in user its own code was broken while every other stateful
 *   route was correctly answering 503.
 * - `POST /deploy` and two upload `PUT`s answered 500 on
 *   `blob write failed for blobs/<hash>: fetch failed`, during a burst of
 *   thirty concurrent 8 MB uploads. A socket that never got a response is the
 *   most retryable failure there is, and 500 is the one answer that tells a
 *   client not to bother.
 *
 * ## What counts, and what deliberately does not
 *
 * The same line `platform-db-errors.ts` draws — REACHABILITY only — read off
 * each library's own taxonomy rather than off message text:
 *
 * - **No response at all.** storage-js models this as `StorageUnknownError`,
 *   which by construction wraps a request that never completed; gotrue-js as
 *   `isAuthRetryableFetchError`. Neither needs a guess.
 * - **A response saying "not now": 429 and 5xx.** A 4xx is the caller's or
 *   ours and stays a 500, because a 503 would tell a client to retry something
 *   that can never succeed. `verifyFresh` already answers 401/403 as
 *   "signed out", which is a third thing again and must not become either.
 *
 * ## Why the ORIGINAL error has to be re-parented
 *
 * `StorageUnknownError` carries the real failure on `originalError`, not on
 * `cause` — so `causeChain` in `error-handler.ts` walked straight past it and
 * the log said `fetch failed` and stopped. That is undici's generic message for
 * every network failure; whether it was a reset socket, a DNS miss or a
 * connect timeout sits one hop below, and it is the only part that says whether
 * the platform or the network is at fault. {@link storageFailureCause} is what
 * puts it back on the chain.
 */

import { isRecord } from "@alexkroman1/aai/utils";

/**
 * A platform HTTP dependency that could not be reached, or that refused to
 * answer right now.
 *
 * A marker class carrying WHICH dependency, for the same reason
 * `PlatformDbUnavailableError` is a marker: the message stays the library's own
 * technical one and the original is kept as `cause`, so the log keeps the
 * diagnosis while the wire body gets the authored sentence in
 * `error-handler.ts`. The `service` is separate from the message because it is
 * the part an operator acts on — "auth is down" and "storage is down" send you
 * to different dashboards, and neither library's message says which it was.
 */
export class PlatformServiceUnavailableError extends Error {
  readonly service: string;

  constructor(service: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlatformServiceUnavailableError";
    this.service = service;
  }
}

/**
 * Whether an HTTP status means "not now" rather than "not ever".
 *
 * 5xx is the dependency failing; 429 is it refusing, which is equally
 * retryable and equally not our fault. Everything else — every 4xx — is a
 * request that will fail identically on retry, so it stays a 500 and gets
 * looked at.
 */
export function isUnavailableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * The error a storage-js failure should carry as its `cause`.
 *
 * `StorageUnknownError.originalError` is where the actual network failure lives
 * — undici's `TypeError: fetch failed` with the real code one `cause` below
 * that — and it is on a property nothing walks. Re-parenting it is what makes
 * `causeChain` able to print `fetch failed <- ECONNRESET` instead of stopping
 * at the first word. Falls back to the error itself, so a `StorageApiError`
 * (which has no original) is unaffected.
 */
export function storageFailureCause(error: unknown): unknown {
  return isRecord(error) && error.originalError !== undefined ? error.originalError : error;
}

/**
 * Whether a storage-js error means Storage could not be reached, or refused.
 *
 * Reads the library's own two shapes rather than the message: an error with no
 * `status` never got a response (`StorageUnknownError`), and one with a status
 * is judged by it. A 404 is NOT handled here — `blob-storage.ts` resolves that
 * to `null` before anything reaches this, because a miss and a failure are
 * different answers to its callers.
 */
export function isStorageUnavailable(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const status = Number(error.status ?? error.statusCode);
  // No usable status means no response arrived — which is the most retryable
  // failure there is, and the one that was answering 500.
  return Number.isFinite(status) ? isUnavailableStatus(status) : true;
}
