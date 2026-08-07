// Copyright 2026 the AAI authors. MIT license.
/**
 * What the caller actually HEARD of the reply in progress — one cursor, one
 * owner.
 *
 * Three things used to guess independently how far a reply got: the playback
 * clock (session-scoped, graced, boolean "still audible"), the reply-tail
 * tracker's character-proportional cut for the resume anchor, and the history
 * writer, which made no estimate at all and recorded what the model GENERATED.
 * The last two are collapsed here so they cannot disagree: if truncation used
 * word timings while the resume prompt kept a proportional cut, the prompt
 * would quote an anchor history says was never spoken. History truncation and
 * the resume anchor are now two readers of ONE answer.
 *
 * **The two biases are opposite, and that asymmetry is the thing to preserve.**
 *
 * | reader | question | grace | errs |
 * | --- | --- | --- | --- |
 * | {@link HeardTracker.pending} | could anything still be audible? | + `PIPELINE_PLAYBACK_GRACE_MS` | LATE |
 * | {@link HeardTracker.heard} | where had the voice actually got to? | − {@link HEARD_AUDIO_LAG_MS} | EARLY |
 *
 * `pending()` errs late because a spurious barge-in cancel is harmless (the
 * client flushes an already-empty buffer) while a missed one lets the agent
 * talk over the caller. The heard cursor errs early because over-keeping is the
 * measured failure — the model believes it delivered information the caller
 * never got, which is the repetition finding on `buildTailResumePrompt` — while
 * under-keeping costs at most a word or two of redundancy, which the resume
 * prompt's "without repeating what they already heard" absorbs. A future
 * unification of the two would get exactly this wrong; same shape as the note
 * in `pipeline-turn-outcome.ts`.
 *
 * **The clock inside is SESSION-scoped, the rest is REPLY-scoped.**
 * `startReply()` deliberately does not touch it: it tracks audio the client is
 * still playing out, which outlives the server-side turn that produced it (that
 * is the whole reason it exists). Only `cut()` — a barge-in, a cancel, a reset,
 * all of which end with the client flushing its playback buffer — restarts it.
 */

import { HEARD_AUDIO_LAG_MS, PIPELINE_PLAYBACK_GRACE_MS } from "../../sdk/constants.ts";
import type { TtsWordTiming } from "../../sdk/providers.ts";
import { buildTailResumePrompt, tailResumeWorthRunning } from "./pipeline-recovery.ts";

/** Estimated client-side playback clock — see {@link createPlaybackClock}. */
type PlaybackClock = {
  /** Advance the clock by one forwarded PCM16 chunk's duration. */
  onChunk(pcm: Int16Array): void;
  /** Restart the clock (the client just flushed its playback buffer). */
  reset(): void;
  /** True while the client may still be playing already-forwarded audio. */
  pending(): boolean;
  /**
   * Estimated ms of forwarded audio the client has not played yet. Ungraced —
   * unlike {@link pending} — because its consumer (the heard cursor) wants
   * "where did the voice stop", not "could anything still be audible".
   */
  remainingMs(): number;
};

/**
 * Track when the client is estimated to finish playing forwarded TTS audio.
 *
 * Synthesis outruns real-time playback, so a turn can finish server-side
 * while the client still holds many seconds of buffered audio; barge-in must
 * keep working through that window or "stop" lets the buffered speech play
 * out in full. Chunks queue client-side, so each forwarded chunk's duration
 * (PCM16 mono: one sample per Int16) accumulates from wherever the previous
 * chunk left off. `pending()` errs late by PIPELINE_PLAYBACK_GRACE_MS since
 * real playback starts after network latency + the client jitter buffer.
 *
 * `now` is injectable so unit tests need no fake timers.
 */
function createPlaybackClock(sampleRateHz: number, now: () => number): PlaybackClock {
  let endsAtMs = 0;
  return {
    onChunk(pcm) {
      const chunkMs = (pcm.length / sampleRateHz) * 1000;
      endsAtMs = Math.max(endsAtMs, now()) + chunkMs;
    },
    reset() {
      endsAtMs = 0;
    },
    pending() {
      return now() < endsAtMs + PIPELINE_PLAYBACK_GRACE_MS;
    },
    remainingMs() {
      return Math.max(0, endsAtMs - now());
    },
  };
}

/** Lowercased alphanumeric projection of one character, or `undefined`. */
function normChar(c: string | undefined): string | undefined {
  if (c === undefined) return;
  const lower = c.toLowerCase();
  return /[a-z0-9]/.test(lower) ? lower : undefined;
}

/** Alphanumeric-only, casefolded projection of a word. */
function normWord(word: string): string {
  let out = "";
  for (const c of word) {
    const n = normChar(c);
    if (n !== undefined) out += n;
  }
  return out;
}

/**
 * Index just past `target` in `text` at or after `from`, comparing only
 * casefolded alphanumerics so the provider's normalization ("$5.00" → "five
 * dollars" is hopeless, but "5.00" → "500" and "Dr." → "dr" are not) does not
 * break the alignment outright.
 */
function findWordEnd(text: string, target: string, from: number): number | undefined {
  if (target.length === 0) return;
  for (let start = from; start < text.length; start++) {
    if (normChar(text[start]) === undefined) continue;
    let ti = 0;
    let i = start;
    while (i < text.length && ti < target.length) {
      const c = normChar(text[i]);
      i++;
      if (c === undefined) continue;
      if (c !== target[ti]) {
        ti = -1;
        break;
      }
      ti++;
    }
    if (ti === target.length) return i;
  }
}

/**
 * Character offset just past each reported word, or `-1` where the word could
 * not be located in the text.
 *
 * Alignment can fail on normalization even with a perfect parse (a provider
 * that speaks "$5.00" as "five dollars" reports words that are simply not in
 * the text), so a miss is recorded rather than fatal: the reader falls back to
 * the last aligned word, and failing that to the proportional estimate — never
 * worse than having no timings at all.
 */
function alignWords(text: string, words: readonly TtsWordTiming[]): number[] {
  const ends: number[] = [];
  let cursor = 0;
  for (const word of words) {
    const end = findWordEnd(text, normWord(word.text), cursor);
    if (end === undefined) {
      ends.push(-1);
      continue;
    }
    cursor = end;
    ends.push(end);
  }
  return ends;
}

/**
 * Index of the last word whose audio had WHOLLY elapsed by `ms` (`endMs`, not
 * `startMs` — a half-spoken word was not heard), or `-1` for none.
 */
function lastHeardWord(words: readonly TtsWordTiming[], ms: number): number {
  let last = -1;
  for (let i = 0; i < words.length; i++) {
    if ((words[i]?.endMs ?? 0) > ms) break;
    last = i;
  }
  return last;
}

/** Character offset of the last ALIGNED word at or before `last`, or `-1`. */
function alignedEnd(ends: readonly number[], last: number): number {
  for (let i = last; i >= 0; i--) {
    const end = ends[i] ?? -1;
    if (end >= 0) return end;
  }
  return -1;
}

/**
 * Snap a character index back to the word boundary at or before it, so a cut
 * never lands mid-word. Returns `index` unchanged when the prefix holds no
 * boundary at all (the cut is inside the reply's first word), which is the
 * behaviour the proportional estimate has always had.
 */
function snapToWord(text: string, index: number): number {
  // At or past the end there is nothing to snap: the whole text was heard, and
  // snapping would drop the reply's last word from the record.
  if (index >= text.length) return text.length;
  // Already ON a boundary — moving back would drop a whole word for nothing.
  if (/\s/.test(text[index] ?? "")) return index;
  const head = text.slice(0, index);
  const boundary = head.lastIndexOf(" ");
  return boundary > 0 ? boundary : head.length;
}

/** Where the caller's ear had got to when the reply was cut. */
export interface HeardPosition {
  /** Characters of the TTS text (filler included) the caller had heard. */
  chars: number;
  /**
   * Characters of the RECORDABLE text inside that prefix — the model's own
   * words, with dead-air filler excluded. This indexes the turn's `accumulated`
   * string, so `accumulated.slice(0, recordableChars)` is a real prefix.
   */
  recordableChars: number;
  /** `accumulated.slice(0, recordableChars)`, i.e. the model text they heard. */
  text: string;
}

/**
 * Per-reply record of what reached TTS and what of it the caller heard.
 *
 * Writers are the transport's provider handlers; readers are the barge-in gate
 * (`pending`), history truncation (`heard`) and false-interruption recovery
 * (`resumePrompt`).
 */
export interface HeardTracker {
  /**
   * Text handed to TTS for the current reply; returns the cumulative TTS
   * transcript (what the interim caption publishes). `record: false` marks
   * dead-air filler — audible, so it counts toward the heard POSITION, but not
   * part of the model's text, so it never counts toward what history records.
   */
  onText(text: string, record: boolean): string;
  /** One forwarded PCM16 chunk of the current reply's TTS audio. */
  onAudio(pcm: Int16Array): void;
  /** Word timings for this reply's audio, already rebased by the adapter. */
  onWords(words: readonly TtsWordTiming[]): void;
  /**
   * A new reply started. Resets the per-reply text, spans, words and latch —
   * but NOT the playback clock, which is session-scoped (see the module doc).
   */
  startReply(): void;
  /** True while the client may still be playing already-forwarded audio. */
  pending(): boolean;
  /**
   * The reply is being cut right now: LATCH the heard position, then restart
   * the playback clock (every abort path ends with the client flushing its
   * buffer).
   *
   * The latch is what makes the readers order-independent. `persistBargeIn`
   * runs when the aborted stream settles, which is necessarily AFTER the abort
   * reset the clock — reading the position then would report every interrupted
   * reply as fully heard, which is exactly the bug this module exists to fix.
   */
  cut(): void;
  /** The heard position — the latched one once {@link cut} has run. */
  heard(): HeardPosition;
  /**
   * Cut-point resume prompt for a barge-in on this reply, or `undefined` when
   * the caller had heard essentially all of it (then a resume turn would only
   * append a fragment to a reply that already landed).
   */
  resumePrompt(): string | undefined;
}

/** Create a {@link HeardTracker}. */
export function createHeardTracker(opts: {
  /** Sample rate of the forwarded PCM16 (Hz), to convert chunks to duration. */
  sampleRate: number;
  /** Ear-lag subtracted from the playback position; defaults to HEARD_AUDIO_LAG_MS. */
  lagMs?: number | undefined;
  /** Clock source; injectable so unit tests need no fake timers. */
  now?: (() => number) | undefined;
}): HeardTracker {
  const lagMs = opts.lagMs ?? HEARD_AUDIO_LAG_MS;
  const now = opts.now ?? Date.now;
  const clock = createPlaybackClock(opts.sampleRate, now);

  // Everything below is REPLY-scoped and reset by startReply().
  let spoken = "";
  // One entry per TTS send, in order: how many characters it carried and
  // whether they belong in the record. Filler must not ride into history even
  // though it is audible — see `emitText` in pipeline-stream-parts.ts for the
  // measured reason.
  let spans: { len: number; record: boolean }[] = [];
  let audioMs = 0;
  let words: TtsWordTiming[] = [];
  let latched: (HeardPosition & { unheardMs: number }) | null = null;

  /** Ms of this reply's audio the caller is estimated to have heard. */
  function heardMs(): number {
    return Math.max(0, Math.min(audioMs, audioMs - clock.remainingMs() - lagMs));
  }

  /**
   * Characters of `spoken` heard by `ms`.
   *
   * With word timings, the last word whose audio has WHOLLY elapsed (`endMs`,
   * not `startMs` — a half-spoken word was not heard). Beyond the last reported
   * word the timeline says nothing, so the proportional estimate takes over,
   * floored at what the words already established.
   */
  function heardChars(ms: number): number {
    if (audioMs <= 0) return 0;
    const proportional = snapToWord(spoken, Math.round((spoken.length * ms) / audioMs));
    if (words.length === 0) return proportional;
    const last = lastHeardWord(words, ms);
    if (last < 0) return 0;
    const end = alignedEnd(alignWords(spoken, words), last);
    // Every heard word failed to align: degrade to the estimate rather than
    // claiming nothing was heard.
    if (end < 0) return proportional;
    return last === words.length - 1 ? Math.max(end, proportional) : end;
  }

  /** Recordable characters inside the first `chars` characters of `spoken`. */
  function recordableChars(chars: number): number {
    let seen = 0;
    let recordable = 0;
    for (const span of spans) {
      if (seen >= chars) break;
      if (span.record) recordable += Math.min(span.len, chars - seen);
      seen += span.len;
    }
    return recordable;
  }

  /** Recordable text inside the first `chars` characters of `spoken`. */
  function recordableText(chars: number): string {
    let seen = 0;
    let out = "";
    for (const span of spans) {
      if (seen >= chars) break;
      if (span.record) out += spoken.slice(seen, seen + Math.min(span.len, chars - seen));
      seen += span.len;
    }
    return out;
  }

  function position(): HeardPosition & { unheardMs: number } {
    const chars = heardChars(heardMs());
    return {
      chars,
      recordableChars: recordableChars(chars),
      text: recordableText(chars),
      unheardMs: clock.remainingMs(),
    };
  }

  return {
    onText(text: string, record: boolean): string {
      spans.push({ len: text.length, record });
      spoken += text;
      return spoken;
    },
    onAudio(pcm: Int16Array): void {
      audioMs += (pcm.length / opts.sampleRate) * 1000;
      clock.onChunk(pcm);
    },
    onWords(incoming: readonly TtsWordTiming[]): void {
      words.push(...incoming);
    },
    startReply(): void {
      spoken = "";
      spans = [];
      audioMs = 0;
      words = [];
      latched = null;
    },
    pending: clock.pending,
    cut(): void {
      latched = position();
      clock.reset();
    },
    heard(): HeardPosition {
      const { chars, recordableChars: recordable, text } = latched ?? position();
      return { chars, recordableChars: recordable, text };
    },
    resumePrompt(): string | undefined {
      const at = latched ?? position();
      if (!tailResumeWorthRunning(audioMs, at.unheardMs)) return;
      // The anchor is the RECORDABLE heard text, which is character-identical
      // to what history records for this reply — so the prompt can never quote
      // words the record denies, and never quotes filler.
      return buildTailResumePrompt(at.text);
    },
  };
}
