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

export type KeyedLock = ((key: string) => Promise<() => void>) & {
  /** Number of keys currently held or queued. Exposed for tests/metrics. */
  readonly size: number;
};

export function createKeyedLock(): KeyedLock {
  // Tail of each key's chain: resolves when the most recent acquirer releases.
  const tails = new Map<string, Promise<void>>();

  const lock = (key: string): Promise<() => void> => {
    const prev = tails.get(key) ?? Promise.resolve();
    const { promise: released, resolve } = Promise.withResolvers<void>();
    const tail = prev.then(() => released);
    tails.set(key, tail);
    void tail.then(() => {
      // Drop the entry once the chain drains — unless a newer acquirer
      // already replaced the tail.
      if (tails.get(key) === tail) tails.delete(key);
    });
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
