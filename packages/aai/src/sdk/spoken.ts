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
 * exists to make cheaper than re-deriving; the retail-orders-agent template had it right and
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
 * The letters and digits of a spoken code, upper-cased, with everything else
 * dropped — {@link spokenDigits} for an id that carries letters too.
 *
 * An order number, a policy number, a booking reference: "r s four four one
 * seven" comes through STT as anything from `RS4417` to `rs-44 17`, and none of
 * them equals the stored `RS4417`. Comparing the raw string is the version
 * that tells a covered member they have no plan. Two templates normalized
 * this way with two regexes; the case fold is the half a hand-written one
 * forgets.
 *
 * ASCII only, on purpose: the ids this exists for are ASCII, and a locale-aware
 * fold would make the same utterance normalize differently on two machines.
 *
 * @example
 * ```ts
 * import { spokenAlphanumeric } from "@alexkroman1/aai";
 *
 * spokenAlphanumeric("rs 44-17"); // "RS4417"
 * spokenAlphanumeric("#W 586 6402"); // "W5866402"
 * ```
 *
 * @public
 */
export function spokenAlphanumeric(spoken: string): string {
  return spoken.toUpperCase().replace(/[^A-Z0-9]/g, "");
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

/**
 * Words too common to be what a caller meant by them — "the Northwind one" is
 * about Northwind.
 *
 * Deliberately short. A longer list starts deciding which real words do not
 * count, and the words that matter here are the ones a candidate's own text
 * shares with a filler: `executive-inbox-agent`, which shipped this set, was
 * matching email subjects, where "for" and "with" appear in half of them.
 */
const MATCH_FILLER: ReadonlySet<string> = new Set([
  "the",
  "that",
  "this",
  "one",
  "ones",
  "your",
  "with",
  "for",
  "and",
]);

/**
 * The shortest word {@link matchWords} will score.
 *
 * Three, which drops the articles and prepositions a filler list would have to
 * enumerate, and — more to the point — drops the two-letter fragments that
 * match everything: a candidate word "an" is inside "Raman", "Tanaka" and
 * "Kowalski" at once.
 */
const MIN_MATCH_WORD = 3;

/**
 * An utterance or a candidate's text as scorable words: lower-cased,
 * punctuation-split, short words and fillers dropped.
 *
 * `[a-z0-9]{3,}` rather than a split on whitespace, so `Liam O'Connor`,
 * `Room (3 nights)` and `Minibar - still water` all tokenize the way a reader
 * would read them. Splitting on whitespace alone leaves `o'connor` as one token
 * that only matches an utterance STT punctuated identically.
 */
const MATCH_WORD_RE = new RegExp(`[a-z0-9]{${MIN_MATCH_WORD},}`, "g");

function matchWords(text: string): string[] {
  return (text.toLowerCase().match(MATCH_WORD_RE) ?? []).filter((word) => !MATCH_FILLER.has(word));
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
   * The candidate's own text, for the WORD-OVERLAP scorer this module ships —
   * how a caller names a thing when they are not reading an id: by the words in
   * it. Return the fields worth matching on and nothing else ("a body match on
   * 'meeting' would tie half the inbox").
   *
   * Every candidate word of at least {@link MIN_MATCH_WORD} characters that the
   * utterance also says scores one, so "Priya Raman" beats "Priya" alone and
   * "room" ties `Room (3 nights)` with `Room service` — a tie being a REFUSAL
   * that asks, which is the outcome a desk wants.
   *
   * It exists because four shipped templates had each written this scorer with
   * four different splitting rules (`/\s+/` vs `[^a-z0-9]+` vs a `{3,}` match;
   * a two-character floor vs three; one filler list vs none), so the same
   * utterance resolved differently in each. Matching is on whole WORDS both
   * ways rather than `text.includes(word)`, which is the rule three of those
   * four intended and one of them got: a substring test lets a candidate word
   * match inside an unrelated one.
   *
   * What it does NOT do is stemming, so a plural in the utterance does not
   * match a singular field ("books" ≠ "book"). A domain where that matters
   * wants `score` — see `entertainment-picks-agent`, which scores two named
   * fields against a listener's plural.
   *
   * Combines with {@link ResolveOneOptions.score} by SUM when both are given,
   * so a domain scorer can break a tie the words leave.
   */
  match?: (candidate: T) => string;
  /**
   * The candidate's CODE, if it has one — an order number, a policy number, a
   * booking reference. Compared through {@link spokenAlphanumeric}, so
   * `#W5866402` is found in "that's order W 586-6402" however STT spaced,
   * punctuated or cased it.
   *
   * Tried FIRST, before a position and before the words: a caller who reads an
   * id out has named exactly one thing, even in an utterance that also says
   * "the first one". The candidate's code must be at least
   * {@link MIN_CODE_CHARS} characters after normalization — below that,
   * containment in a whole utterance is noise rather than a match.
   *
   * **A code that matches NOTHING is not a refusal here**, it falls through to
   * the rest of the ladder. Whether an id-shaped utterance is a closed question
   * ("that order is not on this account") is the caller's knowledge, not this
   * function's — `retail-orders-agent` keeps its own branch for exactly that
   * sentence.
   */
  code?: (candidate: T) => string;
  /**
   * How well a candidate matches the utterance — higher wins, `0` means no
   * match at all. Optional: with no scorer, an utterance that names no position
   * resolves only when there is exactly one candidate.
   *
   * For the DOMAIN scorers a built-in cannot express — a status word, two named
   * fields weighted apart, a distance over prices. Reach for
   * {@link ResolveOneOptions.match} first: plain word overlap is what most
   * callers wrote this by hand to get.
   *
   * `text` is the utterance lower-cased, since every scorer wants that.
   */
  score?: (candidate: T, text: string) => number;
}

/**
 * The shortest normalized code {@link resolveOne} will look for in an
 * utterance.
 *
 * Four. A code is compared by CONTAINMENT, so a short one matches by accident:
 * `spokenAlphanumeric` folds an utterance to bare characters, in which a
 * two-character code appears constantly ("A1" is inside "SEATA1B" and inside
 * half the words in any sentence). Every id this exists for — an order number,
 * a policy number, a booking reference — is longer than that.
 */
const MIN_CODE_CHARS = 4;

/**
 * Pick the one candidate an utterance names, or fail saying why.
 *
 * The order is deliberate and is the part worth reusing:
 *
 * 1. **No candidates** — say so, rather than reporting a failed match against an
 *    empty list.
 * 2. **A code** ({@link ResolveOneOptions.code}), when one is declared — an id
 *    read aloud names exactly one thing, so it wins even over a position in the
 *    same sentence. A miss falls through rather than failing.
 * 3. **A position** ("the second one", "the last one") — a caller who counts is
 *    unambiguous even when nothing else is, and this is the case a scorer alone
 *    cannot see.
 * 4. **The words** — {@link ResolveOneOptions.match} overlap plus
 *    {@link ResolveOneOptions.score}, summed, whichever are given. A single best
 *    candidate wins; a tie fails, listing the tied ones only.
 * 5. **Exactly one candidate left** — it is what they meant.
 * 6. **Anything else is ambiguous**, and the failure lists the candidates.
 *
 * Steps 2 and 4 are the two shapes every caller of this used to write by hand
 * (five shipped templates, four incompatible word splitters between them);
 * `score` stays for the scorers a domain really owns.
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

  const byCode = pickByCode(candidates, spoken, options.code);
  if (byCode.length > 0) return onlyOne(byCode, spoken, label, options.describe);

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

  if (options.score !== undefined || options.match !== undefined) {
    const winners = bestScoring(candidates, spoken, options);
    if (winners.length === 0) {
      return toolFailure(
        `No ${label} matches "${spoken}". Ask which one: ${list(candidates, options.describe)}.`,
      );
    }
    return onlyOne(winners, spoken, label, options.describe);
  }

  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) return only;

  return toolFailure(
    `That is ambiguous — ${candidates.length} ${label}s match. Ask which one: ${list(candidates, options.describe)}.`,
  );
}

/**
 * One winner, or the ambiguity failure that lists the tied ones.
 *
 * Shared by the CODE step and the WORDS step, which reach the same two
 * outcomes: a single match is the answer, and several is a question for the
 * caller rather than a pick. One copy means the sentence cannot drift between
 * the two, and it is what keeps {@link resolveOne} itself readable as the
 * ladder its doc describes.
 */
function onlyOne<T>(
  winners: readonly T[],
  spoken: string,
  label: string,
  describe: (candidate: T) => string,
): T | ToolFailure {
  const winner = winners[0];
  if (winners.length === 1 && winner !== undefined) return winner;
  return toolFailure(
    `"${spoken}" matches ${winners.length} ${label}s. Ask which one: ${list(winners, describe)}.`,
  );
}

/**
 * The candidates tied for the highest positive score — empty when nothing
 * scored at all.
 *
 * `match` overlap and `score` are SUMMED, so a domain scorer can break a tie
 * the words leave and either may be given alone.
 */
function bestScoring<T>(
  candidates: readonly T[],
  spoken: string,
  options: ResolveOneOptions<T>,
): T[] {
  // Captured once: inside this branch each is known to be there or not, and
  // re-reading `options.score?.()` per candidate spells an absence that cannot
  // change mid-loop as a score of zero.
  const score = options.score;
  const match = options.match;
  const text = spoken.toLowerCase();
  // The utterance's words, tokenized ONCE — `match` is consulted per candidate,
  // and re-tokenizing the utterance per row repeats the whole utterance's work
  // for every row of the list.
  const said = match === undefined ? undefined : new Set(matchWords(spoken));
  const scored = candidates.map((candidate) => ({
    candidate,
    score:
      (score?.(candidate, text) ?? 0) +
      (match === undefined || said === undefined
        ? 0
        : matchWords(match(candidate)).filter((word) => said.has(word)).length),
  }));
  // A loop rather than `Math.max(...scored.map(…))`, for the reason
  // `session-state-store.ts` gives at its own maximum: `candidates` is the
  // caller's list and a spread passes one argument per element, so a long
  // enough one is a `RangeError` from a line that reads as an aggregate.
  let best = Number.NEGATIVE_INFINITY;
  for (const one of scored) best = Math.max(best, one.score);
  if (best <= 0) return [];
  return scored.filter((one) => one.score === best).map((one) => one.candidate);
}

/**
 * The candidates whose code the utterance carries — empty when none does, or
 * when no `code` was declared.
 *
 * Containment rather than equality, because an utterance is a sentence: the
 * model relays "that's order W 586-6402", which normalizes to
 * `THATSORDERW5866402`, and the id is inside it. Both sides go through
 * {@link spokenAlphanumeric}, so the caller's spacing, punctuation and case are
 * all transcription noise by the time they are compared — the fold two
 * templates had each written with their own regex.
 */
function pickByCode<T>(
  candidates: readonly T[],
  spoken: string,
  code: ((candidate: T) => string) | undefined,
): T[] {
  if (code === undefined) return [];
  const said = spokenAlphanumeric(spoken);
  if (said === "") return [];
  return candidates.filter((candidate) => {
    const wanted = spokenAlphanumeric(code(candidate));
    return wanted.length >= MIN_CODE_CHARS && said.includes(wanted);
  });
}

/** "is 1 order" / "are 3 orders" — the failure sentences read aloud. */
function count(n: number, label: string): string {
  return n === 1 ? `is 1 ${label}` : `are ${n} ${label}s`;
}

/** Candidates as one readable clause. */
function list<T>(candidates: readonly T[], describe: (candidate: T) => string): string {
  return candidates.map(describe).join("; ");
}
