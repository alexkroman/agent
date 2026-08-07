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
 */

import { createOwnedMap } from "@alexkroman1/aai/internal";

export type KeyedLock = ((key: string) => Promise<() => void>) & {
  /** Number of keys currently held or queued. Exposed for tests. */
  readonly size: number;
};

export function createKeyedLock(): KeyedLock {
  // Tail of each key's chain: resolves when the most recent acquirer releases.
  // Owned by claim so a drained tail can only ever drop its OWN entry, never a
  // newer acquirer's.
  const tails = createOwnedMap<string, Promise<void>>();

  const lock = (key: string): Promise<() => void> => {
    const prev = tails.get(key) ?? Promise.resolve();
    const { promise: released, resolve } = Promise.withResolvers<void>();
    const tail = prev.then(() => released);
    const dropTail = tails.claim(key, tail);
    // Drop the entry once the chain drains.
    void tail.then(dropTail);
    return prev.then(() => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        resolve();
      };
    });
  };

  Object.defineProperty(lock, "size", { get: () => tails.size });
  return lock as KeyedLock;
}

/** Run `fn` while holding a keyed lock, releasing it in every outcome. */
export const withLock = <T>(
  lock: (key: string) => Promise<() => void>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> =>
  lock(key).then(async (release) => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
