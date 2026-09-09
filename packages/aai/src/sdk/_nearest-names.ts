// Copyright 2026 the AAI authors. MIT license.
/**
 * "Did you mean michael?" — the names in a list that an unrecognised one is
 * closest to.
 *
 * Split out of `providers/tts/assemblyai.ts` at the 500-line cap, along a seam
 * that module does not otherwise have: everything here is a pure function of a
 * name and a LIST of names, with no knowledge of voices, languages, descriptors
 * or the warning it feeds. It sits in `sdk/` rather than beside its one caller
 * because `providers/tts/*.ts` is a place where every file must BE a provider
 * (konsistent's `tts-providers`), and because nothing about it is TTS.
 *
 * `_`-prefixed: the sentence it contributes to is `assemblyAIVoiceWarning`'s,
 * and that stays the published one. The next catalog that needs "did you mean"
 * — a gateway model id is the obvious one — should call this rather than copy
 * it.
 */

/**
 * How far a name may be from a catalog id and still be read as a typo of it.
 *
 * Two, which admits a transposition, a dropped letter and a doubled one, and
 * stops `"jane"` → `"jan"`-style near-misses between two REAL entries from
 * pulling in half a list: the shortest voice ids are four characters, so a
 * looser bound starts matching everything short.
 */
const SUGGEST_MAX_DISTANCE = 2;

/** At most this many suggestions — a longer list is the haystack again. */
const SUGGEST_MAX_NAMES = 3;

/**
 * The names closest to `wanted`, best first — at most
 * {@link SUGGEST_MAX_NAMES}, and none at all when nothing is close.
 *
 * The commonest wrong voice is a TYPO of a real one (`"michal"`, `"estele"`),
 * and for that reader a catalog's 40-odd names are a haystack while the one they
 * meant is one character away. Naming it turns the warning from "look this up"
 * into "you meant michael".
 *
 * Edit distance rather than a shared prefix: half these typos are a
 * transposition or a dropped interior letter, which a prefix test scores exactly
 * as badly as an unrelated name. Bounded, because past that distance the
 * "nearest" name is not a correction — it is a different voice, and offering one
 * would be worse than saying nothing.
 *
 * Not on any hot path: it runs once per config, inside a warning that is itself
 * computed once per build.
 */
export function nearestNames(wanted: string, names: readonly string[]): string[] {
  const needle = wanted.toLowerCase();
  return names
    .map((name) => ({ name, distance: editDistance(needle, name.toLowerCase()) }))
    .filter((one) => one.distance <= SUGGEST_MAX_DISTANCE)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, SUGGEST_MAX_NAMES)
    .map((one) => one.name);
}

/**
 * Levenshtein distance, two rows rather than a matrix.
 *
 * Hand-rolled because `sdk/` may take no dependency for this: every agent
 * bundle carries this graph, and the whole use is ranking a few dozen short
 * strings inside a warning nobody sees on a correct config.
 */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitute = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insert = (current[j - 1] ?? 0) + 1;
      const remove = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitute, insert, remove);
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}
