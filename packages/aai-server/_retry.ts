// Copyright 2025 the AAI authors. MIT license.
// Transient-network-error retry helper for upstream storage / HTTP reads.

/**
 * Node.js error codes that indicate a transient network failure worth
 * retrying. These cover the cases we've actually seen surface from fetch()
 * against Tigris / S3-compatible endpoints on Fly.
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
 * Walks an error (and its `cause` chain) looking for a Node error code we
 * treat as transient. `fetch()` wraps the underlying error in a generic
 * `TypeError: fetch failed` whose `cause` carries the real code.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export type RetryOptions = {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Base delay for exponential backoff, ms. Default 50. */
  baseDelayMs?: number;
  /** Called with (attempt, totalAttempts, err) before each retry. */
  onRetry?: (attempt: number, attempts: number, err: unknown) => void;
};

/**
 * Runs `op` and retries on transient network errors only. Non-transient
 * errors (404s from the storage layer return null, auth/parse failures
 * throw non-network errors) pass through unchanged on the first failure.
 *
 * Read operations must be idempotent to be wrapped here.
 */
export async function retryOnTransient<T>(
  op: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 50;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || i === attempts - 1) throw err;
      opts.onRetry?.(i + 1, attempts, err);
      const delay = baseDelayMs * 2 ** i + Math.random() * baseDelayMs;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable — either `return await op()` or the final iteration threw.
  throw lastErr;
}
