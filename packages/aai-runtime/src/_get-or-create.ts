// Copyright 2026 the AAI authors. MIT license.
/**
 * `Map` get-or-create, once.
 *
 * Two modules keyed a per-SESSION entry off the same id and wrote the same four
 * lines to make one lazily — the slot store's `entryFor` and the event stream's.
 * They are not an accidental pair: the two halves of a session's state hang off
 * one key space, so a change to how an entry comes into existence (a default a
 * fresh one carries, a cap on how many there may be) has to land in both or the
 * two disagree about what a session is.
 *
 * `make` runs ONLY on a miss, which is the property both call sites rest on: an
 * entry is mutable and shared, so a factory called on a hit would hand the
 * caller a second one and quietly discard everything already recorded in the
 * first.
 */

/**
 * The entry under `key`, creating and inserting one if there is none.
 *
 * @internal
 */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = make();
  map.set(key, created);
  return created;
}
