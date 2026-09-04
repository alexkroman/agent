// Copyright 2026 the AAI authors. MIT license.
/**
 * Minimal keyed mutex: `lock(key)` resolves with a release function once every
 * earlier holder of the same key has released.
 *
 * The recurring shape it reifies is "serialize the async work touching one
 * entity" — one agent session's state, one project's workspace row, one slug's
 * mutations. It matters most inside an agent because **the LLM loop runs a
 * step's tool calls CONCURRENTLY**: two `async` mutators of the same
 * `ctx.state` interleave at every `await`, so each can read what the other
 * half-applied. That is the bug this exists to make unwriteable, and it is
 * why the primitive is public rather than framework-internal — every author
 * of a stateful multi-tool agent meets it.
 *
 * Two properties that a hand-rolled promise chain has to get right and
 * usually does not:
 *
 * - **The per-key entry is deleted once its chain drains**, so a long-lived
 *   process does not leak one entry per distinct key forever. It is dropped
 *   BY OWNERSHIP (`createOwnedMap`), because the drain settles asynchronously
 *   and the key may already hold a successor by then.
 * - **A waiter that gives up on its deadline must resolve its place in the
 *   chain.** Each acquirer appends its own `released` to the tail, so one that
 *   walks away without resolving leaves a slot that never frees — and every
 *   later acquirer for that key blocks forever. The abandoning waiter is the
 *   only one that can release it.
 */

import pTimeout from "p-timeout";
import { createOwnedMap } from "./owned-map.ts";

/** Thrown when an acquire deadline lapses before the key came free. */
export class KeyedLockTimeoutError extends Error {
  readonly key: string;
  constructor(key: string, timeoutMs: number, options?: ErrorOptions) {
    super(`timed out after ${timeoutMs}ms waiting for the lock on ${key}`, options);
    this.name = "KeyedLockTimeoutError";
    this.key = key;
  }
}

export type KeyedLockOptions = {
  /**
   * Give up waiting after this long and reject with
   * {@link KeyedLockTimeoutError}. Omit to wait indefinitely.
   */
  timeoutMs?: number | undefined;
};

export type KeyedLock = ((key: string, options?: KeyedLockOptions) => Promise<() => void>) & {
  /** Number of keys currently held or queued. Exposed for tests and metrics. */
  readonly size: number;
};

/**
 * Create a {@link KeyedLock}.
 *
 * Prefer {@link withLock} at call sites — it releases in every outcome, which
 * a bare `lock()` leaves to the caller's `finally`.
 */
export function createKeyedLock(): KeyedLock {
  // Tail of each key's chain: resolves when the most recent acquirer releases.
  // Owned by claim so a drained tail can only ever drop its OWN entry, never a
  // newer acquirer's.
  const tails = createOwnedMap<string, Promise<void>>();

  const lock = (key: string, options?: KeyedLockOptions): Promise<() => void> => {
    const prev = tails.get(key) ?? Promise.resolve();
    const { promise: released, resolve } = Promise.withResolvers<void>();
    const tail = prev.then(() => released);
    const dropTail = tails.claim(key, tail);
    // Drop the entry once the chain drains.
    void tail.then(dropTail);
    const acquired = prev.then(() => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        resolve();
      };
    });
    const timeoutMs = options?.timeoutMs;
    if (timeoutMs === undefined) return acquired;
    return pTimeout(acquired, {
      milliseconds: Math.max(1, timeoutMs),
      message: new KeyedLockTimeoutError(key, timeoutMs),
    }).catch((err: unknown) => {
      // GIVE UP OUR PLACE IN THE CHAIN — see the module doc. (Resolving early
      // is harmless if `prev` settles afterwards: the release closure it hands
      // back becomes a no-op on an already-resolved promise, and `tail` drains
      // normally.)
      resolve();
      throw err;
    });
  };

  Object.defineProperty(lock, "size", { get: () => tails.size });
  return lock as KeyedLock;
}

/** Run `fn` while holding a keyed lock, releasing it in every outcome. */
export const withLock = <T>(
  lock: (key: string, options?: KeyedLockOptions) => Promise<() => void>,
  key: string,
  fn: () => Promise<T>,
  options?: KeyedLockOptions,
): Promise<T> =>
  lock(key, options).then(async (release) => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
