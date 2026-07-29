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
 * once `min` is reached (`Infinity` counts them all) — i.e. the result is
 * `min(actual count, min)`.
 *
 * Scans instead of `split()`: STT partials arrive several times a second and
 * grow with the utterance, so allocating a word array per partial is pure
 * garbage on a latency-sensitive path. Exported for callers that only
 * threshold the count (the partial handler in pipeline-user-speech.ts), so a
 * long partial never pays a full O(transcript length) scan.
 */
export function scanWords(text: string, min: number): number {
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

/**
 * True when `text` holds at least `min` whitespace-delimited words. Cheaper
 * than a full count on the barge-in path: `minBargeInWords` is small, so the
 * scan stops after a couple of words instead of walking a long partial.
 */
export function hasMinWords(text: string, min: number): boolean {
  if (min <= 0) return true;
  return scanWords(text, min) >= min;
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
  // Punctuation first: it reads a few tail characters, and a fragment
  // without terminal punctuation is the common case — the cue lookup (which
  // walks back to the last word) then never runs.
  if (!endsWithTerminalPunct(trimmed)) return false;
  return !CONTINUATION_CUES.has(lastWord(trimmed));
}

/** Charcode test for the cue-word alphabet `[a-z']`, case-insensitive. */
function isCueWordChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 39; // a-z A-Z '
}

/**
 * The last `[a-z']+` run of `text`, lowercased — `""` when there is none.
 * Scans backward from the end instead of `toLowerCase().match(/[a-z']+/g)`,
 * which lowercases the whole transcript and allocates every word match just
 * to read the final one.
 */
function lastWord(text: string): string {
  let end = text.length;
  while (end > 0 && !isCueWordChar(text.charCodeAt(end - 1))) end--;
  let start = end;
  while (start > 0 && isCueWordChar(text.charCodeAt(start - 1))) start--;
  return start < end ? text.slice(start, end).toLowerCase() : "";
}

/**
 * Does `text` end with terminal punctuation, allowing trailing closers?
 * Equivalent to `/[.?!]["')\]]*$/.test(text)` but O(tail): an end-anchored
 * regex without a start anchor still scans candidate positions from the
 * front of the string.
 */
function endsWithTerminalPunct(text: string): boolean {
  let i = text.length - 1;
  while (i >= 0) {
    const c = text[i];
    if (c === '"' || c === "'" || c === ")" || c === "]") i--;
    else break;
  }
  if (i < 0) return false;
  const c = text[i];
  return c === "." || c === "?" || c === "!";
}
