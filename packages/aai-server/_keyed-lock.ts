// Copyright 2026 the AAI authors. MIT license.
/**
 * Minimal keyed mutex, drop-in for p-lock's `getLock()` call signature:
 * `lock(key)` resolves with a release function once every earlier holder of
 * the same key has released.
 *
 * Unlike p-lock, the per-key entry is deleted from the map as soon as its
 * promise chain drains, so long-lived processes don't leak one entry per
 * distinct key forever. That matters here because the slug lock is taken
 * pre-auth on WebSocket upgrades, making p-lock's leak attacker-growable.
 *
 * Acquiring can carry a DEADLINE, which is what makes a contended mutation
 * answerable. The cross-replica half of the slug lock has always had one
 * (`lock_timeout` on the reserved connection → `55P03` → 409), but it sits
 * BEHIND this mutex — see platform-lock.ts — so a second mutation of the same
 * slug on the SAME replica never reached it and queued here unbounded instead.
 */

import { createOwnedMap } from "@alexkroman1/aai/internal";
import pTimeout from "p-timeout";

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

export type KeyedLock = ((key: string, opts?: KeyedLockOptions) => Promise<() => void>) & {
  /** Number of keys currently held or queued. Exposed for tests. */
  readonly size: number;
};

export function createKeyedLock(): KeyedLock {
  // Tail of each key's chain: resolves when the most recent acquirer releases.
  // Owned by claim so a drained tail can only ever drop its OWN entry, never a
  // newer acquirer's.
  const tails = createOwnedMap<string, Promise<void>>();

  const lock = (key: string, opts?: KeyedLockOptions): Promise<() => void> => {
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
    const timeoutMs = opts?.timeoutMs;
    if (timeoutMs === undefined) return acquired;
    return pTimeout(acquired, {
      milliseconds: Math.max(1, timeoutMs),
      message: new KeyedLockTimeoutError(key, timeoutMs),
    }).catch((err: unknown) => {
      // GIVE UP OUR PLACE IN THE CHAIN. Each acquirer appends its own
      // `released` to the tail, so a waiter that walks away without resolving
      // it leaves a slot that never frees — and every later acquirer for this
      // key chains behind that slot and blocks forever. The abandoning waiter
      // is the only one that can release it. (Resolving early is harmless if
      // `prev` settles afterwards: the release closure it hands back becomes a
      // no-op on an already-resolved promise, and `tail` drains normally.)
      resolve();
      throw err;
    });
  };

  Object.defineProperty(lock, "size", { get: () => tails.size });
  return lock as KeyedLock;
}

/** Run `fn` while holding a keyed lock, releasing it in every outcome. */
export const withLock = <T>(
  lock: (key: string, opts?: KeyedLockOptions) => Promise<() => void>,
  key: string,
  fn: () => Promise<T>,
  opts?: KeyedLockOptions,
): Promise<T> =>
  lock(key, opts).then(async (release) => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
