// Copyright 2025 the AAI authors. MIT license.
/**
 * Cap'n Web helpers for Deno Worker communication.
 *
 * Provides a thin adapter to make Deno Worker endpoints compatible
 * with capnweb's {@linkcode newMessagePortRpcSession} which expects
 * a MessagePort-like interface.
 *
 * @module
 */

/**
 * Adapt a Deno Worker or worker global scope (`self`) to behave like
 * a `MessagePort` so it can be used with capnweb's
 * `newMessagePortRpcSession`.
 *
 * Workers auto-dispatch messages (no `start()` needed), so we add a
 * no-op `start()` and `close()` to satisfy the MessagePort interface.
 *
 * @param endpoint - The Worker instance (host-side) or `self` (worker-side).
 * @returns The same endpoint, augmented with `start()` and `close()` if missing.
 */
export function asMessagePort(endpoint: {
  postMessage(msg: unknown): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}): MessagePort {
  const ep = endpoint as unknown as Record<string, unknown>;
  if (typeof ep.start !== "function") {
    ep.start = () => {};
  }
  if (typeof ep.close !== "function") {
    ep.close = () => {};
  }
  return endpoint as unknown as MessagePort;
}
