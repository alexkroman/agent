// Copyright 2025 the AAI authors. MIT license.
/**
 * Timeout wrapper for promises, used by both worker-side and host-side RPC.
 *
 * @module
 */

import pTimeout from "p-timeout";

/**
 * Wrap a promise with a timeout. Rejects with `Error` if the promise
 * does not settle within `timeoutMs` milliseconds.
 *
 * If `timeoutMs` is `undefined` or `0`, the original promise is returned
 * unchanged.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  // Wrap in Promise.resolve to normalize capnweb RpcPromise proxies
  // into real Promises that work with Promise.race.
  const normalized = Promise.resolve(promise);
  if (!timeoutMs) return normalized;
  return pTimeout(normalized, {
    milliseconds: timeoutMs,
    message: `RPC timed out after ${timeoutMs}ms`,
  });
}
