// Copyright 2026 the AAI authors. MIT license.
// User-speech state helpers for the pipeline transport: speaking-edge
// detection (pipeline mode has no VAD, so speech_started/speech_stopped
// derive from the STT transcript stream) and false-interruption recovery
// (resume a barged-in reply when the interruption never commits a turn).

/**
 * Edge-detect "user is speaking" from the STT transcript stream: the first
 * partial/final of an utterance fires `onSpeechStarted`, and the utterance
 * committing (or resolving as a false interruption) fires `onSpeechStopped`.
 */
export interface SpeechEdgeTracker {
  /** A non-empty partial or final arrived — open the speaking edge (idempotent). */
  speechStarted(): void;
  /** The utterance resolved (commit / false-alarm) — close the edge (idempotent). */
  speechEnded(): void;
  /**
   * How long the current utterance has been running (ms since the edge
   * opened), or 0 when the user is not speaking. Drives the
   * `interruptionMinDurationMs` barge-in gate.
   */
  durationMs(): number;
  /** Forget the current edge without emitting (session reset). */
  reset(): void;
}

/** Create a {@link SpeechEdgeTracker} bound to the transport callbacks. */
export function createSpeechEdgeTracker(callbacks: {
  onSpeechStarted(): void;
  onSpeechStopped(): void;
}): SpeechEdgeTracker {
  let speaking = false;
  let startedAtMs = 0;
  return {
    speechStarted(): void {
      if (speaking) return;
      speaking = true;
      startedAtMs = Date.now();
      callbacks.onSpeechStarted();
    },
    speechEnded(): void {
      if (!speaking) return;
      speaking = false;
      callbacks.onSpeechStopped();
    },
    durationMs(): number {
      return speaking ? Date.now() - startedAtMs : 0;
    },
    reset(): void {
      speaking = false;
    },
  };
}

/**
 * False-interruption recovery timer. A partial-triggered barge-in aborts the
 * in-flight reply, but STT noise or a hallucinated partial may never produce
 * a final — the settler commits nothing and the agent falls silent
 * mid-thought. `arm()` starts the recovery window after such a barge-in;
 * `clear()` cancels it when real speech commits (or the client cancels). If
 * the window elapses while the transport is idle, `onResume` runs the
 * continuation turn.
 */
export interface FalseInterruptionRecovery {
  /** Start (or restart) the recovery window. No-op when the timeout is 0. */
  arm(): void;
  /** Cancel a pending recovery window. */
  clear(): void;
}

/** Create a {@link FalseInterruptionRecovery}. */
export function createFalseInterruptionRecovery(opts: {
  /** Recovery window in ms; 0 (or negative) disables recovery entirely. */
  timeoutMs: number;
  /** False once the transport terminated — a fired timer then does nothing. */
  isActive: () => boolean;
  /**
   * True while a turn is in flight or client audio may still be playing —
   * something else took the floor, so the interruption resolved itself.
   */
  isBusy: () => boolean;
  /** Run the resume turn. Only called when active and not busy. */
  onResume: () => void;
}): FalseInterruptionRecovery {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function fire(): void {
    timer = null;
    if (!opts.isActive()) return;
    if (opts.isBusy()) return;
    opts.onResume();
  }

  return {
    arm(): void {
      if (opts.timeoutMs <= 0) return;
      clear();
      timer = setTimeout(fire, opts.timeoutMs);
    },
    clear,
  };
}
