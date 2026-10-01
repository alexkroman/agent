// Copyright 2026 the AAI authors. MIT license.
/**
 * Pre-connect audio: the microphone opens when the caller presses start, not
 * when the server's `config` frame arrives, and what they say in between is
 * sent ahead of the live stream.
 *
 * Without it the mic is requested only once `config` names the audio rates —
 * a handshake after the press, plus a sandbox boot on the platform — so an
 * eager "hi, I need to…" spoken while the agent is still joining never reaches
 * the server. The capture runs at {@link PRE_CONNECT_SAMPLE_RATE}, a guess
 * `createVoiceIO` adopts whole when right and resamples when not (`audio/preconnect.ts`).
 *
 * ## Who owns the microphone
 *
 * This holder, from `begin()` until `take()`; the audio path's bring-up after
 * that (`session/audio-setup.ts`), which releases it if the bring-up is
 * abandoned. A reconnect BEFORE `config` keeps the capture buffering — that is
 * exactly the audio this exists for — so only the session's terminal paths
 * call `release()`.
 *
 * @module
 */

import type { PreConnectCapture } from "../audio/index.ts";
import { loadAudioModules } from "./audio-setup.ts";

/**
 * The rate the capture guesses: the SDK's default STT rate
 * (`DEFAULT_STT_SAMPLE_RATE`), which is also the only rate an AssemblyAI S2S
 * agent accepts. A miss costs a resample of the buffer, not the audio.
 */
export const PRE_CONNECT_SAMPLE_RATE = 16_000;

/**
 * The most pre-connect audio held — the LATEST this many seconds. Bounds a
 * cold sandbox boot or a stalled handshake; at 16 kHz it is 320 KB, well
 * inside the server's pre-ready buffer (`MAX_WS_PAYLOAD_BYTES`).
 */
export const PRE_CONNECT_MAX_SECONDS = 10;

/** The session core's handle on its pre-connect capture. @internal */
export type PreConnectAudio = {
  /**
   * Prefetch the audio modules, then open the mic and start buffering unless
   * a capture is already held (or the session opted out).
   */
  begin(): void;
  /** Hand the held capture to a bring-up, or `null` when none is held. */
  take(): Promise<PreConnectCapture | null> | null;
  /** Release a held capture: the session is over or starting afresh. */
  release(): void;
};

/** Build one session's pre-connect capture holder. @internal */
export function createPreConnectAudio(enabled: boolean): PreConnectAudio {
  let held: Promise<PreConnectCapture | null> | null = null;
  return {
    begin() {
      // The prefetch runs even when opted out: it overlaps the chunk fetch
      // with the handshake instead of starting it at `config`. A failure is
      // reported by the bring-up, which awaits the same memoized load.
      void loadAudioModules().catch(() => {
        /* surfaced by the audio path's bring-up */
      });
      if (!enabled || held !== null) return;
      held = Promise.all([import("../audio/index.ts"), loadAudioModules()])
        .then(([{ openPreConnectCapture }, [, captureWorklet]]) =>
          openPreConnectCapture({
            sampleRate: PRE_CONNECT_SAMPLE_RATE,
            captureWorkletSrc: captureWorklet,
            maxSeconds: PRE_CONNECT_MAX_SECONDS,
          }),
        )
        // A failure here is not reported: the bring-up at `config` opens the
        // path the ordinary way and reports its own.
        .catch(() => null);
    },
    take() {
      const taken = held;
      held = null;
      return taken;
    },
    release() {
      const taken = held;
      held = null;
      void taken?.then((capture) => capture?.close());
    },
  };
}
