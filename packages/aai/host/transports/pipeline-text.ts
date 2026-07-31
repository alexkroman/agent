// Copyright 2026 the AAI authors. MIT license.
// Transcript-text analysis for pipeline turn-taking: word counting on interim
// STT transcripts (barge-in gating).
//
// Split out of `pipeline-stream.ts`, which owns LLM-stream consumption — these
// helpers only look at STT text and are consumed by `pipeline-user-speech.ts`.

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
