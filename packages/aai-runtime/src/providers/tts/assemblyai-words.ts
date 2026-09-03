// Copyright 2026 the AAI authors. MIT license.
/**
 * `WordBoundaries` frames for the AssemblyAI streaming TTS adapter: reading
 * them off the wire, and rebasing their offsets onto the turn's audio timeline.
 *
 * Split out for the same reason `assemblyai-segment.ts` and
 * `assemblyai-turn.ts` are — the adapter owns socket and turn lifecycle, this
 * owns one rule.
 *
 * **The wire shape is not fully verified.** The only in-repo provenance for
 * this frame is the `audio_start_ms` observation recorded in
 * `assemblyai-segment.ts`'s module doc (per-flush padding: 0, 880, 1680,
 * 2400), which is where the field name comes from; AssemblyAI's public docs
 * have no streaming-TTS page. So the parse below is deliberately TOLERANT of
 * both plausible shapes — a batch (`{ words: [...] }`) and a single top-level
 * word — reads several spellings of each offset, and returns `[]` for anything
 * it cannot make sense of. A malformed frame must never throw: killing a voice
 * session over a history nicety would be absurd, and the consumer degrades to
 * a proportional estimate when no timings arrive.
 *
 * That same observation is also the strongest argument for using word timings
 * at all rather than mapping characters proportionally: per-flush padding is
 * exactly the error a character-proportional cut cannot model.
 */

import type { TtsWordTiming } from "@alexkroman1/aai/host-internal";
import { isRecord } from "@alexkroman1/aai/utils";

/** One raw word object as it may appear on the wire. */
type RawWord = Record<string, unknown>;

/** First finite number among the candidate field spellings, else undefined. */
function readMs(raw: RawWord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
}

const START_KEYS = ["audio_start_ms", "start_ms", "start"] as const;
const END_KEYS = ["audio_end_ms", "end_ms", "end"] as const;

/** Parse one word object; `undefined` when it carries no usable timing. */
function readWord(value: unknown): TtsWordTiming | undefined {
  if (!isRecord(value)) return;
  const text = value.text ?? value.word;
  if (typeof text !== "string") return;
  const startMs = readMs(value, START_KEYS);
  if (startMs === undefined) return;
  // A frame that reports only a start still locates the word; treat the word
  // as instantaneous rather than dropping it. `endMs` is what the heard cursor
  // compares against, so this errs toward counting the word as heard early —
  // the one place this module leans that way, and only when the service tells
  // us nothing better.
  const endMs = readMs(value, END_KEYS) ?? startMs;
  return { text, startMs, endMs: Math.max(startMs, endMs) };
}

/**
 * Read a `WordBoundaries` frame into word timings, in the provider's own clock.
 *
 * Returns `[]` for a frame of an unknown shape, and never throws. Accepts both
 * a batch of words and a single top-level word — see the module doc for why
 * both are covered.
 */
export function readWordBoundaries(msg: unknown): TtsWordTiming[] {
  if (!isRecord(msg)) return [];
  const batch = msg.words ?? msg.word_boundaries;
  if (Array.isArray(batch)) {
    const out: TtsWordTiming[] = [];
    for (const entry of batch) {
      const word = readWord(entry);
      if (word) out.push(word);
    }
    return out;
  }
  const single = readWord(msg);
  return single ? [single] : [];
}

/** Rebases provider word offsets onto one turn's audio timeline. */
export interface WordTimeline {
  /**
   * Rebase one frame's words. Returns them in turn-relative ms, monotone
   * non-decreasing, or `[]` when the frame carried nothing usable.
   */
  rebase(words: readonly TtsWordTiming[]): TtsWordTiming[];
  /** A new turn started — nothing from the last one carries over. */
  reset(): void;
}

/**
 * Create a {@link WordTimeline}.
 *
 * The service's clock may be per-socket cumulative or per-flush (this adapter
 * flushes several times per turn and the two cases are indistinguishable from
 * one frame), so the rule anchors on what is knowable: the FIRST frame of a
 * turn starts at zero, which is exact either way. A later frame whose first
 * start falls below the previous frame's last end is a detected RESTART — a
 * per-flush clock — and is re-anchored at that last end, which is where the
 * new segment's audio actually begins. Words are then clamped monotone, so a
 * frame that reorders or overlaps cannot walk the cursor backwards.
 */
export function createWordTimeline(): WordTimeline {
  // Added to provider offsets to get turn-relative ms.
  let offsetMs: number | undefined;
  // Highest turn-relative end emitted so far, for restart detection + clamping.
  let lastEndMs = 0;

  return {
    rebase(words) {
      if (words.length === 0) return [];
      const firstStart = words[0]?.startMs ?? 0;
      if (offsetMs === undefined) {
        offsetMs = -firstStart;
      } else if (firstStart + offsetMs < lastEndMs) {
        // The provider's clock went backwards: it is per-flush, so this frame
        // describes audio that starts where the last one ended.
        offsetMs = lastEndMs - firstStart;
      }
      const shift = offsetMs;
      const out: TtsWordTiming[] = [];
      for (const word of words) {
        const startMs = Math.max(lastEndMs, word.startMs + shift);
        const endMs = Math.max(startMs, word.endMs + shift);
        lastEndMs = endMs;
        out.push({ text: word.text, startMs, endMs });
      }
      return out;
    },
    reset() {
      offsetMs = undefined;
      lastEndMs = 0;
    },
  };
}
