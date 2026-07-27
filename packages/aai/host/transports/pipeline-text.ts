// Copyright 2026 the AAI authors. MIT license.
// Transcript-text analysis for pipeline turn-taking: word counting on interim
// STT transcripts (barge-in gating) and the complete-vs-fragment heuristic that
// sizes the endpoint settle window.
//
// Split out of `pipeline-stream.ts`, which owns LLM-stream consumption — these
// helpers only look at STT text and are consumed by `pipeline-transport.ts` and
// `pipeline-endpointing.ts`.

const NON_SPACE = /\S/;

/** Whether `text[i]` is whitespace, matching `/\s/` exactly. */
function isSpaceAt(text: string, i: number): boolean {
  const code = text.charCodeAt(i);
  // ASCII covers every separator STT actually emits; above it, defer to the
  // regex so exotic Unicode spaces classify the same way `/\s+/` would.
  if (code < 0x80) return code === 32 || (code >= 9 && code <= 13);
  return !NON_SPACE.test(text[i] as string);
}

/**
 * Count whitespace-delimited words in an interim transcript, stopping early
 * once `min` is reached (`Infinity` counts them all).
 *
 * Scans instead of `split()`: STT partials arrive several times a second and
 * grow with the utterance, so allocating a word array per partial is pure
 * garbage on a latency-sensitive path.
 */
function scanWords(text: string, min: number): number {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpaceAt(text, i)) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      if (++count >= min) return count;
    }
  }
  return count;
}

/** Count whitespace-delimited words in an interim transcript. */
export function countWords(text: string): number {
  return scanWords(text, Number.POSITIVE_INFINITY);
}

/**
 * True when `text` holds at least `min` whitespace-delimited words. Cheaper
 * than {@link countWords} on the barge-in path: `minBargeInWords` is small, so
 * the scan stops after a couple of words instead of walking a long partial.
 */
export function hasMinWords(text: string, min: number): boolean {
  if (min <= 0) return true;
  return scanWords(text, min) >= min;
}

/** True when `text` holds at least one non-whitespace character. */
export function hasSpeech(text: string): boolean {
  return hasMinWords(text, 1);
}

/**
 * Trailing tokens that signal the speaker is mid-thought and more speech is
 * coming — fillers, dangling connectives, articles, and prepositions. A final
 * ending in one of these is treated as incomplete even if it carries terminal
 * punctuation, so the endpoint settle window aggregates the continuation.
 */
const CONTINUATION_CUES: ReadonlySet<string> = new Set([
  "um",
  "umm",
  "uh",
  "uhh",
  "er",
  "erm",
  "hmm",
  "mm",
  "so",
  "and",
  "but",
  "or",
  "then",
  "because",
  "cause",
  "actually",
  "wait",
  "no",
  "well",
  "like",
  "the",
  "a",
  "an",
  "to",
  "for",
  "with",
  "of",
  "my",
  "at",
  "in",
  "on",
  "i",
  "i'm",
  "let",
  "let's",
]);

/**
 * Heuristic: does an STT final read as a complete utterance (commit now) versus
 * a fragment likely to be continued (wait for the settle window)?
 *
 * Complete = ends with terminal punctuation and its last word is not a
 * continuation cue. STT emits punctuation on confident end-of-turn finals; a
 * mid-utterance pause fragment ("find a two-bedroom in Austin") usually lacks
 * it, and self-corrections trail off on a cue ("actually make it"). Errs toward
 * waiting (the safe, aggregating side) when unsure.
 */
export function utteranceLooksComplete(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const words = trimmed.toLowerCase().match(/[a-z']+/g);
  const lastWord = words?.at(-1) ?? "";
  if (CONTINUATION_CUES.has(lastWord)) return false;
  return /[.?!]["')\]]*$/.test(trimmed);
}
