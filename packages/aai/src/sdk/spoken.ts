// Copyright 2026 the AAI authors. MIT license.
/**
 * Turning what a caller SAID into exactly one thing they meant.
 *
 * A voice agent's arguments do not arrive as ids. "Cancel my second order",
 * "the blue medium one", "eight six four two, one nine…" — a tool holding a list
 * of candidates has to pick one, and the interesting part is not the picking. It
 * is what happens when the utterance picks none, or more than one.
 *
 * **Ambiguity is an ANSWER, never a guess.** The consequence of guessing here is
 * cancelling the wrong order, so a miss and a tie both return a
 * {@link ToolFailure} that LISTS the candidates — which is the one shape that
 * lets the model recover on its own turn ("I see two — the jacket or the
 * boots?") instead of acting and apologizing. That is the rule this module
 * exists to make cheaper than re-deriving; the retail template had it right and
 * had it alone.
 *
 * What is here is only the part that is the same for every domain: spoken
 * digits, ordinals, and the pick-exactly-one contract. The vocabulary — what an
 * order id looks like, which words name a status — stays with the agent that
 * knows it.
 */

import { type ToolFailure, toolFailure } from "./utils.ts";

/**
 * The digits of a spoken number, with everything else dropped.
 *
 * STT renders a read-aloud id every way a human says one — `"8642 1975"`,
 * `"8642-1975"`, `"864 219 75"` — and none of them equals the stored id. All of
 * them have the same digits in the same order.
 *
 * @example
 * ```ts
 * import { spokenDigits } from "@alexkroman1/aai";
 *
 * spokenDigits("that's 864-219-75"); // "86421975"
 * ```
 *
 * @public
 */
export function spokenDigits(spoken: string): string {
  return spoken.replace(/\D/g, "");
}

/**
 * Position words, as an index into the candidate list. `-1` is "the last one".
 *
 * Both spellings of each, because STT writes whichever the caller's cadence
 * suggests.
 */
const ORDINALS: Readonly<Record<string, number>> = {
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  fourth: 3,
  "4th": 3,
  fifth: 4,
  "5th": 4,
  sixth: 5,
  "6th": 5,
  last: -1,
};

/**
 * {@link ORDINALS} as compiled word-boundary patterns, in declaration order.
 *
 * Built ONCE at module load. `new RegExp(...)` inside the loop compiled all
 * thirteen on every call, and this is on the tool path — `resolveOne` consults
 * it for every candidate list a voice agent resolves.
 */
const ORDINAL_PATTERNS: readonly (readonly [RegExp, number])[] = Object.entries(ORDINALS).map(
  ([word, index]) => [new RegExp(`\\b${word}\\b`), index] as const,
);

/**
 * The position an utterance names, as an index, or `undefined` if it names none.
 *
 * `-1` means the LAST candidate, following `Array.prototype.at` — which is also
 * how "the last one" has to be read, since it is a position from the other end.
 *
 * Matched on word boundaries, so "firstly" and "the 21st" do not read as
 * positions — a substring test finds `first` in one and `1st` in the other, and
 * both would pick a candidate the caller never named.
 *
 * What a boundary cannot rule out is a position word used as an ordinary noun:
 * "the first aid kit" really does contain the word "first". That is the reason
 * {@link resolveOne} takes a position only AFTER the caller has narrowed by
 * whatever its domain understands — an id, a status word — rather than before.
 *
 * @example
 * ```ts
 * import { spokenOrdinal } from "@alexkroman1/aai";
 *
 * spokenOrdinal("cancel the second one"); // 1
 * spokenOrdinal("cancel the last one"); // -1
 * spokenOrdinal("cancel my order"); // undefined
 * ```
 *
 * @public
 */
export function spokenOrdinal(spoken: string): number | undefined {
  const text = spoken.toLowerCase();
  for (const [pattern, index] of ORDINAL_PATTERNS) {
    if (pattern.test(text)) return index;
  }
  return undefined;
}

/** Options for {@link resolveOne}. */
export interface ResolveOneOptions<T> {
  /**
   * One candidate as the model should hear it read back — this is what a
   * failure lists, so it has to be enough to choose between them out loud.
   */
  describe: (candidate: T) => string;
  /**
   * What the candidates are called, for the failure sentences. Defaults to
   * `"option"`. Singular: the plural is formed with `s`.
   */
  label?: string;
  /**
   * How well a candidate matches the utterance — higher wins, `0` means no
   * match at all. Optional: with no scorer, an utterance that names no position
   * resolves only when there is exactly one candidate.
   *
   * `text` is the utterance lower-cased, since every scorer wants that.
   */
  score?: (candidate: T, text: string) => number;
}

/**
 * Pick the one candidate an utterance names, or fail saying why.
 *
 * The order is deliberate and is the part worth reusing:
 *
 * 1. **No candidates** — say so, rather than reporting a failed match against an
 *    empty list.
 * 2. **A position** ("the second one", "the last one") — a caller who counts is
 *    unambiguous even when nothing else is, and this is the case a scorer alone
 *    cannot see.
 * 3. **The scorer**, when one is given. A single best candidate wins; a tie
 *    fails, listing the tied ones only.
 * 4. **Exactly one candidate left** — it is what they meant.
 * 5. **Anything else is ambiguous**, and the failure lists the candidates.
 *
 * The caller is expected to have narrowed first — by an id, by a status word,
 * by whatever its domain says an utterance can mean. This resolves what is
 * left.
 *
 * @example
 * ```ts
 * import { resolveOne } from "@alexkroman1/aai";
 *
 * type Jacket = { id: string; color: string };
 * const jackets: Jacket[] = [
 *   { id: "1", color: "blue" },
 *   { id: "2", color: "red" },
 * ];
 *
 * const picked = resolveOne(jackets, "the blue one", {
 *   label: "jacket",
 *   describe: (jacket) => `${jacket.id} (${jacket.color})`,
 *   score: (jacket, text) => (text.includes(jacket.color) ? 1 : 0),
 * });
 * // → { id: "1", color: "blue" }
 * ```
 *
 * @public
 */
export function resolveOne<T>(
  candidates: readonly T[],
  spoken: string,
  options: ResolveOneOptions<T>,
): T | ToolFailure {
  const label = options.label ?? "option";
  if (candidates.length === 0) {
    return toolFailure(`There is no ${label} to choose from.`);
  }

  const index = spokenOrdinal(spoken);
  if (index !== undefined) {
    const picked = candidates.at(index);
    // `=== undefined`, never `!picked`: `at` reports "no such position" with
    // `undefined` and nothing else, so a truthiness test additionally rejects a
    // candidate that is legitimately falsy — `resolveOne<0 | 5>` could not
    // return `0`, and an empty-string candidate could never be picked at all.
    // The other two picks in this function already read it this way.
    if (picked === undefined) {
      return toolFailure(
        `There is no such ${label} — there ${count(candidates.length, label)}: ${list(candidates, options.describe)}.`,
      );
    }
    return picked;
  }

  if (options.score) {
    // Captured once: inside this branch the scorer is known to be there, and
    // re-reading `options.score?.()` per candidate spells an absence that cannot
    // happen here as a score of zero.
    const score = options.score;
    const text = spoken.toLowerCase();
    const scored = candidates.map((candidate) => ({
      candidate,
      score: score(candidate, text) ?? 0,
    }));
    // A loop rather than `Math.max(...scored.map(…))`, for the reason
    // `session-state-store.ts` gives at its own maximum: `candidates` is the
    // caller's list and a spread passes one argument per element, so a long
    // enough one is a `RangeError` from a line that reads as an aggregate.
    let best = Number.NEGATIVE_INFINITY;
    for (const one of scored) best = Math.max(best, one.score);
    if (best <= 0) {
      return toolFailure(
        `No ${label} matches "${spoken}". Ask which one: ${list(candidates, options.describe)}.`,
      );
    }
    const winners = scored.filter((one) => one.score === best).map((one) => one.candidate);
    const winner = winners[0];
    if (winners.length === 1 && winner !== undefined) return winner;
    return toolFailure(
      `"${spoken}" matches ${winners.length} ${label}s. Ask which one: ${list(winners, options.describe)}.`,
    );
  }

  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) return only;

  return toolFailure(
    `That is ambiguous — ${candidates.length} ${label}s match. Ask which one: ${list(candidates, options.describe)}.`,
  );
}

/** "is 1 order" / "are 3 orders" — the failure sentences read aloud. */
function count(n: number, label: string): string {
  return n === 1 ? `is 1 ${label}` : `are ${n} ${label}s`;
}

/** Candidates as one readable clause. */
function list<T>(candidates: readonly T[], describe: (candidate: T) => string): string {
  return candidates.map(describe).join("; ");
}
