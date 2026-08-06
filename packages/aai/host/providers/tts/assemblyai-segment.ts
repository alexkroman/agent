// Copyright 2026 the AAI authors. MIT license.
/**
 * Segmentation for the AssemblyAI streaming TTS adapter: where to cut the
 * buffered reply text so each piece can be flushed for synthesis.
 *
 * `Flush` is the only thing that starts synthesis (`Generate` merely buffers —
 * see the module doc in `assemblyai.ts`), so this decision alone sets
 * time-to-first-audio. It is split out for the same reason `assemblyai-turn.ts`
 * is: the adapter owns socket and turn lifecycle, this owns one measured rule.
 *
 * **Segment size is a measured tradeoff**, because each flushed segment is
 * synthesized as its own utterance with its own prosody and padding. For one
 * fixed text: end-of-turn flush only = 5.44s of audio but no sound until the
 * stream ended; flushing every word-granularity delta = 94ms to first audio but
 * 14.16s of audio (2.6x, audibly disjointed); flushing per *sentence* = 6.48s vs
 * 6.24s for the same three sentences, i.e. ~4%. Hence
 * {@link SEGMENT_BOUNDARY_RE} — sentence-terminal punctuation only, never the
 * commas the pipeline's own coalescer breaks on. {@link MIN_SEGMENT_WORDS} then
 * holds off on single-token segments, which are the abbreviation false positives
 * ("Dr. ", "e.g. ") that measured 25% longer audio; they simply wait for the rest
 * of the sentence. Two words is the floor rather than a character count because
 * every hold/cover phrase ("One moment.", "Almost there.") is a short two-word
 * sentence that *must* still flush — being audible mid-turn is the only reason
 * those phrases exist.
 *
 * **A sentence end is not guaranteed to arrive soon, so {@link MAX_SEGMENT_CHARS}
 * breaks the wait.** Sentence-only segmentation makes time-to-first-audio the
 * length of the reply's FIRST SENTENCE, and an opening clause like "Let me pull
 * up the details on that order for you and check where it currently is." is most
 * of a second of silence on its own. Measured against production 2026-08-06 on a
 * reply with exactly that shape (medians of 3 runs, 30ms delta pacing):
 * sentence-only = 538ms to first audio / 12.64s of audio; adding the 40-char
 * budget = **286ms / 14.00s** — roughly half the latency for ~11% more audio.
 *
 * **Do NOT read that as "flush more, get more".** The curve is not monotonic in
 * flush count; the real constraint is a floor on segment LENGTH. Same text, one
 * run each: 4 flushes 12.64s, 5 (per-clause) 13.28s, 6 (40-char) 14.00s — but 15
 * (per-3-word) **21.20s**, and per-delta 3.1x. The service's `WordBoundaries`
 * frames show the mechanism directly: under per-delta flushing their
 * `audio_start_ms` steps 0, 880, 1680, 2400, i.e. **every flush is padded into a
 * ~800ms slot no matter how little text it carries**. So a segment must stay
 * well clear of that slot; 40 characters is roughly three seconds of speech and
 * does, while a per-clause boundary buys nothing measurable because clause marks
 * cluster near sentence marks anyway.
 *
 * The budget is therefore a floor-BREAKER, not a cap — a buffer already holding
 * complete sentences still flushes as one large segment, which is both better
 * prosody and fewer round trips.
 */

import { hasMinWords } from "../../transports/pipeline-text.ts";

/** The text to synthesize now, and the remainder to keep buffering. */
export interface Segment {
  head: string;
  tail: string;
}

/**
 * A sentence end anywhere in the buffered text: terminal punctuation, optional
 * closing quotes/brackets, then whitespace or the end of the buffer. The
 * trailing-whitespace requirement is what keeps "3.5" and "v1.2" from matching.
 *
 * Deliberately narrower than the pipeline coalescer's CLAUSE_BOUNDARY_RE, which
 * also breaks on `,;:` — a comma is mid-sentence, and flushing there hands the
 * server a fragment to synthesize with a falling final intonation.
 */
const SEGMENT_BOUNDARY_RE = /[.!?…]["')\]]*(?:\s|$)/g;

/**
 * Words a segment needs before sentence-terminal punctuation flushes it — see
 * the module doc. Single-token segments are abbreviations far more often than
 * sentences.
 */
const MIN_SEGMENT_WORDS = 2;

/**
 * Characters after which a segment flushes with no sentence end in sight — the
 * ceiling on how long the caller waits for the reply's first sound. Measured;
 * see the module doc for why this is a length floor rather than a flush budget,
 * and why going much below it falls off a cliff.
 */
const MAX_SEGMENT_CHARS = 40;

/** A word's final character plus the whitespace run that ends it. */
const WORD_END_RE = /\S\s+/g;

/**
 * Split `buffered` after the last whole word inside {@link MAX_SEGMENT_CHARS}.
 *
 * Only whole words: cutting mid-token would hand the service half an identifier
 * to pronounce, and the halves are synthesized as separate utterances, so
 * nothing downstream can rejoin them.
 */
function splitAtBudget(buffered: string): Segment | undefined {
  if (buffered.length < MAX_SEGMENT_CHARS) return;
  let fits: number | undefined;
  let firstEnd: number | undefined;
  // matchAll clones the regex, so the shared `lastIndex` is never mutated here.
  for (const m of buffered.matchAll(WORD_END_RE)) {
    const end = m.index + m[0].length;
    firstEnd ??= end;
    if (end > MAX_SEGMENT_CHARS) break;
    fits = end;
  }
  // No whole word fits, so a single token already overruns the budget (a URL, an
  // order number). Cut after that token rather than holding it: every later
  // delta only lengthens the buffer, so a budget that is already exceeded could
  // never be satisfied again and the text would wait for end of turn — the exact
  // whole-turn lag mid-stream flushing exists to avoid.
  const end = fits ?? firstEnd;
  if (end === undefined) return;
  return { head: buffered.slice(0, end), tail: buffered.slice(end) };
}

/**
 * Split `buffered` at the LAST sentence boundary whose head is a big enough
 * utterance, or failing that at {@link MAX_SEGMENT_CHARS}. `undefined` means
 * hold everything and wait for more text.
 *
 * The *last* boundary rather than the first: when several sentences arrive
 * before a flush, one larger segment sounds better than several small ones and
 * costs fewer round trips. Word count only grows with prefix length, so the last
 * boundary's head qualifies exactly when any boundary's head does — one
 * early-exit word scan replaces a per-boundary count (this runs on every
 * coalesced chunk of every reply).
 *
 * A sentence boundary always WINS over the budget, even when far past it: it is
 * the better place to break, and the budget exists only to bound the wait for
 * one.
 */
export function splitSegment(buffered: string): Segment | undefined {
  let end: number | undefined;
  // matchAll clones the regex, so the shared `lastIndex` is never mutated here.
  for (const m of buffered.matchAll(SEGMENT_BOUNDARY_RE)) end = m.index + m[0].length;
  if (end !== undefined && hasMinWords(buffered.slice(0, end), MIN_SEGMENT_WORDS)) {
    return { head: buffered.slice(0, end), tail: buffered.slice(end) };
  }
  return splitAtBudget(buffered);
}
