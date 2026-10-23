// Copyright 2026 the AAI authors. MIT license.
/**
 * A state-machine predicate that is cheap to ask on a hot path.
 *
 * Several actor queries run per audio frame — whether the session may still
 * take audio, whether the turn gate is open — and `snapshot.matches()` is not
 * cheap at that rate: at 1200 concurrent sessions those calls were ~13% of the
 * main thread. An XState snapshot is immutable and replaced only on a
 * transition, so a predicate over it can be memoized on the snapshot's
 * IDENTITY and answer exactly what a fresh `matches()` would, recomputed a few
 * times per call instead of on every frame.
 *
 * Any predicate of a machine actor that a per-frame path reads goes through
 * here, so the immutability assumption is stated (and would be fixed) once.
 *
 * @module
 */

/**
 * `pick(actor.getSnapshot())`, recomputed only when the snapshot changes.
 *
 * `pick` must be a pure function of the snapshot.
 */
export function memoOnSnapshot<S, T>(
  actor: { getSnapshot(): S },
  pick: (snapshot: S) => T,
): () => T {
  let seen: S | undefined;
  let answer: T;
  return (): T => {
    const snapshot = actor.getSnapshot();
    if (snapshot !== seen) {
      seen = snapshot;
      answer = pick(snapshot);
    }
    return answer;
  };
}
