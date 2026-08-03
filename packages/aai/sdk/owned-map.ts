// Copyright 2026 the AAI authors. MIT license.
/**
 * A map whose entries are removed by ownership token, not by key.
 *
 * The hazard this reifies: an entry's async teardown (a session's `stop()`,
 * a socket's close handler) can settle after the same key has been re-claimed
 * by a successor — a reconnect resuming a session id, a redeploy replacing a
 * slot — and a bare `map.delete(key)` in that teardown wipes the successor's
 * entry. The repeated hand-rolled guard was `if (map.get(key) === mine)
 * map.delete(key)`, an invariant nothing enforced at the next call site.
 *
 * Here `claim()` is the only write and returns the release function for that
 * specific claim; releasing after a re-claim is a no-op by construction. Use
 * {@link OwnedMap.owns} for non-delete mutations that only the current
 * claimant may perform (e.g. re-arming a slot's idle timer).
 */

/** @internal */
export interface OwnedMap<K, V> {
  /**
   * Install `value` under `key`, replacing any current entry (the previous
   * claimant's release becomes a no-op). Returns the release for this claim:
   * it deletes the entry only while this claim still owns it, and reports
   * whether it did.
   */
  claim(key: K, value: V): () => boolean;
  get(key: K): V | undefined;
  has(key: K): boolean;
  /** Does `value` still hold `key`? Guards mutations other than removal. */
  owns(key: K, value: V): boolean;
  /**
   * Unconditional removal by key — for owner-driven flows (e.g. an explicit
   * delete API) where evicting a successor is the caller's intent. Teardown
   * paths must use the claim's release instead.
   */
  delete(key: K): boolean;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  readonly size: number;
  clear(): void;
}

/**
 * Create an {@link OwnedMap}.
 *
 * @internal
 */
export function createOwnedMap<K, V>(): OwnedMap<K, V> {
  const map = new Map<K, V>();
  return {
    claim(key: K, value: V): () => boolean {
      map.set(key, value);
      return () => {
        if (map.get(key) !== value) return false;
        return map.delete(key);
      };
    },
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    owns: (key, value) => map.get(key) === value,
    delete: (key) => map.delete(key),
    keys: () => map.keys(),
    values: () => map.values(),
    get size(): number {
      return map.size;
    },
    clear(): void {
      map.clear();
    },
  };
}
