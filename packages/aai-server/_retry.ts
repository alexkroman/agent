// Copyright 2025 the AAI authors. MIT license.
// Transient-network-error retry helper for upstream storage / HTTP reads.

import isNetworkError from "is-network-error";
import pRetry from "p-retry";

/**
 * Node/undici error codes we treat as transient in addition to the standard
 * `TypeError: fetch failed` wrapper that `is-network-error` recognizes.
 * These surface outside that wrapper (e.g. body-phase socket failures) from
 * fetch() against Tigris / S3-compatible endpoints on Fly.
 */
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Walks an error (and its `cause` chain) looking for a transient network
 * failure — either a fetch network error (via `is-network-error`) or a Node
 * error code we treat as transient. Wrappers like ofetch's `FetchError`
 * carry the real error in `cause`.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (isNetworkError(cur)) return true;
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

type RetryOptions = {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Base delay for exponential backoff, ms. Default 50. */
  baseDelayMs?: number;
  /** Called with (attempt, totalAttempts, err) before each retry. */
  onRetry?: (attempt: number, attempts: number, err: unknown) => void;
};

/**
 * Runs `op` and retries on transient network errors only (exponential
 * backoff with jitter via p-retry). Non-transient errors (404s from the
 * storage layer return null, auth/parse failures throw non-network errors)
 * pass through unchanged on the first failure.
 *
 * Read operations must be idempotent to be wrapped here.
 */
export async function retryOnTransient<T>(
  op: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { attempts = 3, baseDelayMs = 50, onRetry } = opts;
  return pRetry(op, {
    retries: attempts - 1,
    minTimeout: baseDelayMs,
    randomize: true,
    shouldRetry: ({ error }) => isTransientNetworkError(error),
    onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
      if (retriesLeft > 0 && isTransientNetworkError(error)) {
        onRetry?.(attemptNumber, attempts, error);
      }
    },
  });
}
