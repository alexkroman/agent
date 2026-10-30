// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a reply resumes after a pacing recovery (`3010`): how much of the
 * OLDEST unacknowledged flush — the one being synthesized when the socket was
 * closed — the caller has already been given, decided from evidence rather than
 * assumed.
 *
 * Split out for the same reason `assemblyai-segment.ts` and
 * `assemblyai-turn.ts` are: the adapter owns the socket, this owns one rule.
 *
 * - **No `Audio` frame for it** — nothing of it reached the caller, so it is
 *   re-sent WHOLE. A burst can trip `3010` before the first segment made a
 *   sound, and dropping it would silently lose a whole sentence (a
 *   confirmation number).
 * - **Audio, and word timings covered by that audio** — resume after the last
 *   word whose audio was delivered. A `WordBoundaries` frame can arrive before
 *   the audio it describes, so a word counts only when its END lies within the
 *   audio actually received for this flush; offsets are per flush (see
 *   `assemblyai-words.ts`), as is the audio count, so the two compare directly.
 * - **Audio but no usable timings** — drop it, as before: repeating the start
 *   of a sentence the caller just heard is worse than losing its tail.
 *
 * Matching words to text is deliberately strict: received words must be the
 * flush's own words, IN ORDER from its start, compared without case or
 * punctuation. A `WordBoundaries` frame may TRAIL the previous flush's
 * `FlushDone` (`assemblyai.ts`), so non-matching words before the first match
 * are skipped as the previous flush's; a mismatch after it ends the match
 * where it stands rather than guessing.
 */

import type { TtsWordTiming } from "../openers.ts";

/** What arrived for the oldest unacknowledged flush before the socket closed. */
export interface FlushEvidence {
  /** Milliseconds of its audio received (and emitted to the session). */
  audioMs: number;
  /** Its word timings as received — per-flush offsets, not rebased. */
  words: readonly TtsWordTiming[];
}

const WORD_RE = /\S+/g;

/** A word as matched: letters and digits only, case-folded. */
const normalize = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The text of `head` the caller has NOT been given yet, judged from
 * `evidence`: all of it, the part after the last delivered word, or nothing.
 */
export function unheardText(head: string, evidence: FlushEvidence): string {
  if (evidence.audioMs <= 0) return head;
  const tokens = [...head.matchAll(WORD_RE)]
    .map((m) => ({ norm: normalize(m[0]), end: m.index + m[0].length }))
    .filter((token) => token.norm.length > 0);
  let matched = 0;
  for (const word of evidence.words) {
    const norm = normalize(word.text);
    const covered = word.endMs <= evidence.audioMs;
    if (covered && norm.length > 0 && norm === tokens[matched]?.norm) {
      matched += 1;
    } else if (matched > 0 && (norm.length > 0 || !covered)) {
      // Past the first match, an uncovered or foreign word ends it.
      break;
    }
  }
  const last = tokens[matched - 1];
  return last === undefined ? "" : head.slice(last.end).trimStart();
}
