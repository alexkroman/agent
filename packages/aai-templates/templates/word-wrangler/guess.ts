/**
 * Whether a guess IS the word, and whether a description GAVE the word away —
 * their web client's `detectWordGuess` and the host prompt's "the describer
 * CANNOT say any part of the word", as two pure functions.
 *
 * Both are deliberately forgiving in the same direction: articles, case,
 * punctuation and a trailing plural are not the difference between a right
 * guess and a wrong one, and a describer who says "elephants" has said
 * "elephant". What neither does is fuzzy-match — "giraffe" for "gazelle" is a
 * wrong guess, and a game that rounds it up has no reason to keep score.
 */

/** Lowercase, punctuation-free, single-spaced, and without a leading article. */
export function normalizeWord(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .replace(/^(a|an|the) /, "");
}

/** `elephants` → `elephant`, `dishes` → `dish`; anything short is left alone. */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** Is `guess` the word? Exact after normalizing, or the same word with a plural on either side. */
export function isCorrectGuess(guess: string, word: string): boolean {
  const g = normalizeWord(guess);
  const w = normalizeWord(word);
  if (g === "" || w === "") return false;
  if (g === w || singular(g) === singular(w)) return true;
  // "Is it a giraffe?" relayed whole: the word appears as a whole word inside the guess.
  return containsWord(g, w);
}

/**
 * Does `text` contain the word — or any part of a multi-word one — as a whole
 * word, plural allowed? This is the foul test on a description.
 *
 * Parts shorter than three letters are ignored so "ice cream" is not given away
 * by the word "a"; a two-letter part of a phrase is not a hint anyone scores.
 */
export function containsWord(text: string, word: string): boolean {
  const haystack = ` ${normalizeWord(text)} `;
  const parts = normalizeWord(word)
    .split(/[\s-]+/)
    .filter((p) => p.length >= 3);
  return parts.some((part) => {
    const stem = singular(part);
    return new RegExp(
      `(^|[^a-z0-9])(${escapeRegex(part)}|${escapeRegex(stem)})(s|es)?([^a-z0-9]|$)`,
    ).test(haystack);
  });
}

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
