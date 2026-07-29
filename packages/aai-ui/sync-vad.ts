// Copyright 2026 the AAI authors. MIT license.
/**
 * Client-side utterance detection (VAD) for sync mode.
 *
 * Sync mode has no streaming STT to endpoint speech server-side, so the
 * browser decides where an utterance ends: this module is a pure
 * energy-based voice-activity state machine fed PCM16 frames (from the
 * WebRTC capture pipeline in `sync-mic.ts` — `getUserMedia`'s voice
 * processing handles echo cancellation and noise suppression upstream,
 * which is what makes a simple RMS gate workable). No browser APIs are
 * touched here, so the state machine is fully unit-testable.
 *
 * Lifecycle per utterance: idle (keeping a pre-roll ring of recent audio)
 * → candidate speech (voiced frames accumulating toward `minSpeechMs`)
 * → speaking → `hangoverMs` of silence closes the utterance, which is
 * returned as one PCM16 buffer including the pre-roll and the hangover
 * tail (leading context and trailing silence both help one-shot STT).
 */

/** Tuning for {@link createUtteranceDetector}. */
export type UtteranceDetectorOptions = {
  /** Sample rate of pushed PCM16 frames, in Hz. */
  sampleRate: number;
  /** RMS level (0..1 of full scale) a frame must exceed to count as voiced. */
  speechRms?: number;
  /** Sustained voiced audio required before an utterance starts. Filters clicks. */
  minSpeechMs?: number;
  /** Silence that ends an utterance once one has started. */
  hangoverMs?: number;
  /** Audio kept from before speech onset, so a soft first syllable survives. */
  prerollMs?: number;
  /** Hard cap: a monologue this long is emitted as an utterance mid-speech. */
  maxUtteranceMs?: number;
};

export const DEFAULT_SPEECH_RMS = 0.015;
export const DEFAULT_MIN_SPEECH_MS = 150;
export const DEFAULT_HANGOVER_MS = 700;
export const DEFAULT_PREROLL_MS = 300;
export const DEFAULT_MAX_UTTERANCE_MS = 30_000;

/** Utterance detector — feed PCM16 frames, get complete utterances back. */
export type UtteranceDetector = {
  /**
   * Push one capture frame (any length). Returns a complete utterance when
   * this frame closed one, else null.
   */
  push(frame: Int16Array): Int16Array | null;
  /** End of stream: returns any in-progress utterance (candidate audio that
   *  never reached `minSpeechMs` is discarded as noise). */
  flush(): Int16Array | null;
  /** True while an utterance is being captured. */
  readonly speaking: boolean;
  /** Discard all buffered audio and return to idle. */
  reset(): void;
};

function rmsOf(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const s of frame) {
    const f = s / 0x80_00;
    sum += f * f;
  }
  return Math.sqrt(sum / frame.length);
}

function concat(frames: Int16Array[]): Int16Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

/** Create an energy-based {@link UtteranceDetector}. */
export function createUtteranceDetector(opts: UtteranceDetectorOptions): UtteranceDetector {
  const {
    sampleRate,
    speechRms = DEFAULT_SPEECH_RMS,
    minSpeechMs = DEFAULT_MIN_SPEECH_MS,
    hangoverMs = DEFAULT_HANGOVER_MS,
    prerollMs = DEFAULT_PREROLL_MS,
    maxUtteranceMs = DEFAULT_MAX_UTTERANCE_MS,
  } = opts;
  const msOf = (frame: Int16Array): number => (frame.length / sampleRate) * 1000;

  // Idle-state ring of recent frames, capped at prerollMs.
  let preroll: Int16Array[] = [];
  let prerollTotalMs = 0;
  // Current utterance (candidate or confirmed), including its preroll.
  let utterance: Int16Array[] = [];
  let utteranceMs = 0;
  let speaking = false;
  /** Consecutive voiced ms while still a candidate (below minSpeechMs). */
  let candidateVoicedMs = 0;
  /** Consecutive silent ms while speaking (toward hangoverMs). */
  let silenceMs = 0;

  function toIdle(): void {
    utterance = [];
    utteranceMs = 0;
    speaking = false;
    candidateVoicedMs = 0;
    silenceMs = 0;
  }

  function pushPreroll(frame: Int16Array): void {
    preroll.push(frame);
    prerollTotalMs += msOf(frame);
    while (preroll.length > 0 && prerollTotalMs - msOf(preroll[0] as Int16Array) >= prerollMs) {
      prerollTotalMs -= msOf(preroll.shift() as Int16Array);
    }
  }

  function beginCandidate(frame: Int16Array): void {
    utterance = [...preroll, frame];
    utteranceMs = prerollTotalMs + msOf(frame);
    preroll = [];
    prerollTotalMs = 0;
    candidateVoicedMs = msOf(frame);
  }

  function finalize(): Int16Array {
    const out = concat(utterance);
    toIdle();
    return out;
  }

  // Idle: wait for a voiced frame; everything else rolls into preroll.
  function pushIdle(frame: Int16Array, voiced: boolean): void {
    if (!voiced) {
      pushPreroll(frame);
      return;
    }
    beginCandidate(frame);
  }

  // Candidate: still confirming the onset was speech, not a click.
  function pushCandidate(frame: Int16Array, voiced: boolean): void {
    if (!voiced) {
      // Onset was a transient — demote the candidate back to preroll.
      for (const f of utterance) pushPreroll(f);
      toIdle();
      return;
    }
    utterance.push(frame);
    utteranceMs += msOf(frame);
    candidateVoicedMs += msOf(frame);
  }

  // Speaking: accumulate; silence runs toward the hangover close.
  function pushSpeaking(frame: Int16Array, voiced: boolean): Int16Array | null {
    utterance.push(frame);
    utteranceMs += msOf(frame);
    silenceMs = voiced ? 0 : silenceMs + msOf(frame);
    return silenceMs >= hangoverMs ? finalize() : null;
  }

  return {
    get speaking() {
      return speaking;
    },
    push(frame: Int16Array): Int16Array | null {
      if (frame.length === 0) return null;
      const voiced = rmsOf(frame) >= speechRms;

      let closed: Int16Array | null = null;
      if (speaking) {
        closed = pushSpeaking(frame, voiced);
      } else if (utterance.length > 0) {
        pushCandidate(frame, voiced);
      } else {
        pushIdle(frame, voiced);
      }
      if (closed) return closed;

      if (!speaking && candidateVoicedMs >= minSpeechMs) speaking = true;
      if (speaking && utteranceMs >= maxUtteranceMs) return finalize();
      return null;
    },
    flush(): Int16Array | null {
      const out = speaking ? finalize() : null;
      this.reset();
      return out;
    },
    reset(): void {
      preroll = [];
      prerollTotalMs = 0;
      toIdle();
    },
  };
}
