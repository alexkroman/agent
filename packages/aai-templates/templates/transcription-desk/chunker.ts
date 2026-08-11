// Copyright 2026 the AAI authors. MIT license.
/**
 * Where to cut a recording into chunks the Sync API will accept.
 *
 * Split from `client.tsx` because the two halves have completely different
 * testability: {@link planChunks} is a pure function over sample indices and is
 * specced directly, while {@link speechRegions} needs a WASM model, an
 * `AudioContext` and a browser. Keeping the decision separate from the
 * detection is also what lets the page DEGRADE — a VAD that will not load falls
 * back to fixed windows, and the planner cannot tell the difference.
 *
 * **Why cut on silence at all.** A fixed 60-second window lands mid-word about
 * as often as not, and the Sync API sees each chunk in isolation: the word
 * straddling the boundary is half a word to both requests, so it comes back
 * wrong twice and the seam reads as a transcription error rather than a
 * chunking one. Cutting where nobody is speaking costs nothing and removes the
 * whole class.
 */

/** A half-open span of samples, `[start, end)`. */
export type Span = { start: number; end: number };

/**
 * Silence shorter than this is not a boundary.
 *
 * The gap between two words inside a sentence is routinely 100-200 ms, and
 * cutting there is exactly the mid-utterance split this exists to avoid. 300 ms
 * is comfortably past an inter-word gap and comfortably under a sentence break.
 */
export const MIN_SILENCE_MS = 300;

/**
 * Plan chunk boundaries over `total` samples, given where the speech is.
 *
 * Greedy and deliberately simple: extend the current chunk as far as the cap
 * allows, then cut at the LAST silence that fits. Anything cleverer (balancing
 * chunk lengths, say) would trade a property that matters — every chunk is
 * legal — for one that does not.
 *
 * @param total Length of the recording in samples.
 * @param speech Speech spans in sample indices, ascending and non-overlapping.
 * @param maxSamples Hard cap per chunk. The API's real ceiling.
 * @param minSilenceSamples Shortest gap that counts as a boundary.
 * @returns Contiguous spans covering `[0, total)`. Empty when `total` is 0.
 */
export function planChunks(
  total: number,
  speech: readonly Span[],
  maxSamples: number,
  minSilenceSamples: number,
): Span[] {
  if (total <= 0) return [];
  if (total <= maxSamples) return [{ start: 0, end: total }];

  // The midpoint of each long-enough gap: cutting in the MIDDLE of the silence
  // leaves both neighbours their own trailing and leading quiet, which is what
  // the recognizer uses to place the first and last word.
  const cuts: number[] = [];
  for (let i = 1; i < speech.length; i++) {
    const gapStart = speech[i - 1]?.end;
    const gapEnd = speech[i]?.start;
    if (gapStart === undefined || gapEnd === undefined) continue;
    if (gapEnd - gapStart >= minSilenceSamples) cuts.push(Math.floor((gapStart + gapEnd) / 2));
  }

  const spans: Span[] = [];
  let cursor = 0;
  let nextCut = 0;
  while (total - cursor > maxSamples) {
    const limit = cursor + maxSamples;
    // Advance through the cuts that fit, keeping the last one — the chunk
    // should be as long as it legally can be, so a recording with a pause every
    // two seconds does not become a chunk every two seconds.
    let chosen: number | undefined;
    while (nextCut < cuts.length) {
      const cut = cuts[nextCut];
      if (cut === undefined || cut > limit) break;
      // A cut at or before the cursor is behind us; skip without choosing it,
      // or the loop would emit an empty span and never terminate.
      if (cut > cursor) chosen = cut;
      nextCut++;
    }
    // No usable silence in this window — the speaker simply has not paused, and
    // an over-long chunk is refused outright (`audio_too_long`). Cut anyway.
    const end = chosen ?? limit;
    spans.push({ start: cursor, end });
    cursor = end;
  }
  spans.push({ start: cursor, end: total });
  return spans;
}

/**
 * Fixed windows, for when speech detection is unavailable.
 *
 * The page's fallback, and the behaviour this template shipped with — so a VAD
 * that fails to load costs transcript quality at the seams and nothing else.
 */
export function fixedChunks(total: number, maxSamples: number): Span[] {
  return planChunks(total, [], maxSamples, 0);
}
