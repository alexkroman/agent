// Copyright 2026 the AAI authors. MIT license.
/**
 * Joining segment transcripts back into one — and the only module here the PAGE
 * imports.
 *
 * That is the whole reason it exists as its own file. Segments are transcribed
 * one per step and each one is emitted the moment it lands (`emit("transcript",
 * …)` in `transcribe.ts`), so the page can render the answer growing rather than
 * a spinner — and to render it, the page has to do exactly what `mergeTranscript`
 * does at the end: put the pieces in order and drop the words the overlap made
 * duplicates.
 *
 * Two copies of that would drift, and they would drift INVISIBLY: a live
 * transcript that stitches differently from the stored one reads as the model
 * having changed its mind. So the seam logic is here, imported by the run and by
 * the browser, with nothing else in the module — no directive, no I/O, no SDK
 * import — so pulling it into the client bundle costs a few hundred bytes.
 *
 * `wav.ts` and `sync-api.ts` sit under `workflows/` on the same terms: the WDK
 * builder scans this directory and transforms only what carries a directive.
 */

/**
 * The stream a run publishes its segments into as they land.
 *
 * Declared HERE because it is the one string the run and the page have to agree
 * on: a step emits into it and `client.tsx` subscribes by it, and a typo is a
 * panel that renders nothing with nothing saying why. Both sync flows write it;
 * the async flow has one segment and nothing to stream.
 */
export const TRANSCRIPT_STREAM = "transcript";

/**
 * One segment as it goes over {@link TRANSCRIPT_STREAM}.
 *
 * Its own type rather than the step's journaled result widened, because the two
 * have different readers: `mergeTranscript` needs an index and words, while
 * somebody watching a partial transcript needs to know WHICH part of the
 * recording each piece is — the list has holes in it until the run finishes, and
 * "0:00–1:30" beside a paragraph is what explains a jump.
 */
export type TranscriptChunk = {
  index: number;
  /** Where this piece starts in the recording. */
  startMs: number;
  /** Where it ends. */
  endMs: number;
  text: string;
};

/** Most words {@link stitchTranscript} will look back over to find a repeated seam. */
const MAX_SEAM_WORDS = 40;

/** A word, stripped of the punctuation the decoder added, for seam comparison. */
function seamKey(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/**
 * Join segment transcripts, dropping the words the overlap made duplicates.
 *
 * Segments overlap by `SEGMENT_OVERLAP_SECONDS` (see `wav.ts` for why), so the
 * last few words of one segment are the first few of the next — verbatim when
 * the decoder heard them the same way, which is the common case because it heard
 * the same audio. This finds the longest such run and removes one copy.
 *
 * Comparison is on `seamKey`, not the raw words: the two passes punctuate
 * differently at their own edges (one ends a sentence where the other is
 * mid-clause), so `"today."` and `"today"` are the same word and a raw compare
 * finds no seam at all. The text KEPT is the raw text — only the match is
 * normalized.
 *
 * A missed seam repeats a few words, which a reader can see and forgive. A
 * false one would delete speech, so the search is bounded at
 * {@link MAX_SEAM_WORDS} and always prefers the LONGEST match: a single repeated
 * "the" is not evidence of anything, and requiring the longest run is what stops
 * it counting as one when a longer match is available.
 *
 * **A gap is not a seam, which is what makes this safe to run on a PARTIAL
 * list.** The page stitches whatever segments have arrived, and while a run is in
 * flight that list has holes in it — segment 4 may land before segment 3. Two
 * pieces that were never adjacent share no overlap, so no seam is found and both
 * are kept whole: the live text reads with a jump in it until the missing piece
 * arrives, rather than quietly losing a sentence.
 */
export function stitchTranscript(parts: readonly string[]): string {
  const merged: string[] = [];
  for (const part of parts) {
    const next = part.split(/\s+/).filter(Boolean);
    if (next.length === 0) continue;
    if (merged.length === 0) {
      merged.push(...next);
      continue;
    }
    merged.push(...next.slice(seamLength(merged, next)));
  }
  return merged.join(" ");
}

/** How many leading words of `next` repeat the tail of `merged`. */
function seamLength(merged: readonly string[], next: readonly string[]): number {
  const limit = Math.min(MAX_SEAM_WORDS, merged.length, next.length);
  // Longest first, so a short accidental match never wins over a real seam.
  for (let length = limit; length > 0; length--) {
    const tail = merged.slice(merged.length - length);
    if (tail.every((word, at) => seamKey(word) === seamKey(next[at] ?? ""))) return length;
  }
  return 0;
}

/**
 * Order the chunks that have arrived and stitch them — what the PAGE renders.
 *
 * Sorted here rather than by the caller because arrival order is the one thing a
 * live reader definitely does not have: segments are transcribed concurrently and
 * each is emitted the moment it lands, so chunk 4 routinely precedes chunk 3.
 *
 * A COPY, because the caller's list is React state.
 */
export function stitchChunks(chunks: readonly TranscriptChunk[]): string {
  return stitchTranscript([...chunks].sort((a, b) => a.index - b.index).map((chunk) => chunk.text));
}
