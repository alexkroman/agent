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

/**
 * Canonical form for comparing two transcripts of the same utterance:
 * lowercased, every non-alphanumeric character collapsed to a single space,
 * trimmed.
 *
 * This IS the preemptive-generation match rule (`pipeline-speculation.ts`): a
 * speculation started from an interim is adopted only when the committed final
 * normalizes to the same string. Byte equality would be the safer default and
 * is deliberately not used, because a partial and its final routinely differ in
 * FORMATTING alone — the AssemblyAI adapter traces `turn_is_formatted` per turn
 * (`host/providers/stt/assemblyai.ts`), so "my order is 1 2 3 4" and "My order
 * is 1234." are the same utterance twice. That is a provider PROPERTY visible in
 * the adapter, not a measurement.
 *
 * Note what this deliberately does NOT normalize away: word order, added words,
 * dropped words. A final that merely EXTENDS the partial is a mismatch, and must
 * stay one — answering half an utterance is the failure the endpointing
 * measurement on `DEFAULT_MIN_TURN_SILENCE_MS` paid 5.7x reward for.
 */
/**
 * One letter or digit, in any script.
 *
 * Module scope because {@link normalizeUtterance} tests it once per CHARACTER
 * and runs on every STT partial — a literal in the loop is a fresh `RegExp` per
 * character, so a 100-character partial allocated 100 of them, ~5 times a second
 * while the caller is speaking. No `g` flag, so there is no `lastIndex` to share.
 */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

export function normalizeUtterance(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of text.toLowerCase()) {
    if (ALPHANUMERIC.test(ch)) {
      if (pendingSpace && out.length > 0) out += " ";
      pendingSpace = false;
      out += ch;
    } else {
      pendingSpace = true;
    }
  }
  return out;
}
