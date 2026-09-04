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
 * **There is no continuous mode to reach for instead, and that is now
 * verified rather than assumed.** Probed against the live service 2026-08-18:
 * the client->server vocabulary is exactly `Generate`, `Flush`, `Terminate`,
 * `KeepAlive`, `Cancel` (the server enumerates it when handed an unknown
 * type); `Generate` with no `Flush` produced zero audio in 20 s; no field on
 * `Generate` triggers synthesis (`flush`, `final`, `continue`, `auto_flush`
 * are all silently ignored); and no connect param enables one — the `Begin`
 * frame echoes the complete accepted configuration and holds nothing of the
 * kind. So the seam between segments is a property of the PROVIDER, and the
 * only knobs are the two below. Cartesia has no equivalent (`continue: true`
 * synthesizes on arrival), which is the alternative if the seam matters more
 * than the rest of the pipeline's AssemblyAI-single-key story.
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
 *
 * **Re-measured 2026-08-17 against the live service, and the interesting cell is
 * the fourth: adding clause marks to {@link SEGMENT_BOUNDARY_RE} on top of the
 * budget changes time-to-first-audio by NOTHING.** Same text (a reply whose
 * opening clause is long and comma-rich, i.e. the best case for clause flushing),
 * 30 ms delta pacing, medians of 3:
 *
 * | boundary | budget | first audio | audio |
 * | --- | --- | --- | --- |
 * | `.!?…` | none | 253 ms | 15.84 s |
 * | `.!?…,;:` | none | 127 ms | 17.68 s |
 * | `.!?…` | 40 (shipped) | **96 ms** | 18.64 s |
 * | `.!?…,;:` | 40 | 96 ms | 18.24 s |
 *
 * Clause marks DO halve the latency of sentence-only segmentation on their own —
 * that much is real — and the budget then beats them anyway, because 40
 * characters comes up before the first comma does. With the budget in place the
 * punctuation class can only add flushes LATER in the reply, where the caller is
 * already listening to something and the only effect left is the ~800 ms padding
 * slot. That is the measurement behind "buys nothing measurable" above, with the
 * mechanism named: the budget pre-empts it.
 *
 * Two caveats on those numbers. First-audio was tight (±1-8 ms across runs) and
 * the durations were not (spreads of 0.9-1.4 s, 5-8%), so only the large duration
 * steps are outside the noise — the last two rows are indistinguishable. And this
 * is ONE sentence shape: which rule fires first depends on where the first clause
 * mark falls, so a reply opening "Sure, let me check." reaches a comma at five
 * characters, where {@link MIN_SEGMENT_WORDS} holds it anyway.
 *
 * **Whoever measures this next: pace the deltas.** An unpaced capture hands the
 * segmenter the whole reply before its first cut, and every rule above then
 * scores an identical ~40 ms — the service's own latency and nothing else. That
 * mistake was made while producing this table; `captureTtsTrace`'s
 * `deltaIntervalMs` in `aai-ui/worklets/_tts-trace-harness.ts` exists because of
 * it.
 *
 * **A duration spread is not the service being noisy until the SEGMENTS are
 * ruled out, and the first time this was measured they were the cause.**
 * Against `streaming-tts.sandbox025.assemblyai-labs.com` (2026-08-27), one
 * fixed 223-character snippet at 24 kHz, five runs each, the two boundary
 * classes INTERLEAVED so server load could not be read as an effect:
 *
 * | closer class | segments | first audio | audio | spread |
 * | --- | --- | --- | --- | --- |
 * | `["')]` (straight only) | 7 | ~750 ms | 16.70 s | 2.96 s (**18%**) |
 * | `["'’”)]` (shipped) | 7 | ~750 ms | 18.86 s | 1.04 s (**6%**) |
 *
 * Same flush count, same time-to-first-audio, and the spread falls by 3x. The
 * straight-only class could not see `me.”`, so it cut mid-sentence
 * (`"uploaded me.”\nThe clock ticks faster. "`) and the model had no cadence
 * to aim for — a fragment's prosody is unconstrained, so it came out different
 * every run. Read that as the rule behind {@link SEGMENT_BOUNDARY_RE} rather
 * than a second knob: a segment that IS a sentence synthesizes consistently.
 *
 * The cost is real and is the reason this is a trade rather than a free win:
 * **+2.16 s, 13% more audio**, because a sentence delivered as a sentence gets
 * the terminal lengthening and falling cadence the rushed fragment skipped.
 * That is the right direction — it is the same 4% sentence-vs-clause cost the
 * table above already accepts — but do not go looking for it as a saving.
 *
 * What the residual 6% is: the service. Identical text, identical cuts, 18.40
 * to 19.44 s, so a neural voice samples a different delivery each generation.
 * Decomposed against the `WordBoundaries` frames' own offsets over four runs,
 * the PADDING is the stable part — 17-18% of every run (3.03-3.51 s), lead-in
 * 130-425 ms and tail 200-760 ms per segment, per-segment spreads of 16-236 ms
 * — while per-segment SPEECH moved by 239-561 ms. So an A/B on this host wants
 * five runs minimum, and it wants to compare speech-in-words rather than total
 * audio when the cut changes. What held across every run of all three
 * experiments: one ack per flush, a 0.6-1.9 s drain (nowhere near
 * `PIPELINE_FLUSH_TIMEOUT_MS`), and every byte of audio arriving before `done`.
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
 * **The closer class carries the CURLY quotes as well as the straight ones**,
 * and the straight-only version was a real miss rather than a nicety: a model
 * writes `whispering: “You were the one who uploaded me.”`, and `.”` matched
 * nothing, so the sentence end was invisible and the cut fell to
 * {@link MAX_SEGMENT_CHARS} in the middle of the NEXT sentence. Typographic
 * quotes are what an LLM emits by default, so this was the common case and not
 * the edge one — measured on the sandbox host, one snippet of three sentences
 * cut as `"uploaded me.”\nThe clock ticks faster. "` instead of after
 * `me.”`. `’` doubles as an apostrophe (`isn’t`, `sister’s`), which is
 * harmless here: the class only applies AFTER a terminal `.!?…`.
 *
 * The pipeline coalescer's TERMINAL_BOUNDARY_RE draws the same line for the
 * same reason — a comma is mid-sentence, and flushing there hands the server a
 * fragment to synthesize with a falling final intonation — so the two classes
 * must be changed together. This one still
 * matches ANYWHERE in the buffer rather than only at its end, and carries the
 * {@link MIN_SEGMENT_WORDS} floor, so the two are not interchangeable.
 */
const SEGMENT_BOUNDARY_RE = /[.!?…]["'’”)\]]*(?:\s|$)/g;

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
