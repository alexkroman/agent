// Copyright 2025 the AAI authors. MIT license.

/**
 * How the audio path is OPENED: the module load, the mic grant, the worklet
 * registration, and the {@link VoiceIO} those three produce.
 *
 * WHEN one is opened, whether it is still wanted by the time it settles, and
 * what happens to audio that arrives meanwhile all live in
 * `session-core-audio-state.ts` — the same split `s2s-lifecycle.ts` and
 * `pipeline-speech-edges.ts` draw in the runtime, and for the same reason:
 * nothing here reads or writes session state, so it is callable from an
 * invoked actor and testable without one.
 */

import type { VoiceIO } from "./audio.ts";

type AudioModules = [typeof import("./audio.ts"), string, string];

let audioModulesPromise: Promise<AudioModules> | null = null;

/**
 * Load the audio module and worklet sources, memoized so a prefetch at
 * `connect()` time overlaps the chunk fetch with the WebSocket handshake
 * instead of serializing it behind the server's `config` frame. A failed
 * load clears the memo so the next attempt retries the import.
 */
export function loadAudioModules(): Promise<AudioModules> {
  audioModulesPromise ??= Promise.all([
    import("./audio.ts"),
    import("./worklets/capture-processor.ts").then((m) => m.default),
    import("./worklets/playback-processor.ts").then((m) => m.default),
  ]).catch((err: unknown) => {
    audioModulesPromise = null;
    throw err;
  });
  return audioModulesPromise;
}

/** The audio parameters the server's `config` frame carries. */
export type AudioPathConfig = {
  sampleRate: number;
  ttsSampleRate: number;
};

/**
 * What a live audio path reports back.
 *
 * Both of the last two used to be guarded at the callback by
 * `conn.generation.isCurrent(gen)`; they are plain reports now, and whether
 * one still matters is the state machine's answer — see
 * `session-core-audio-state.ts`.
 */
export type AudioPathCallbacks = {
  /** Buffered PCM16 from the microphone, for the socket. */
  onMicData(pcm16: ArrayBuffer): void;
  /** Unplayed agent audio in the buffer, in ms — the host's closed playback loop. */
  onProgress(bufferedMs: number): void;
  /** A worklet processor died after setup: the audio path is gone. */
  onFailure(message: string): void;
};

/**
 * Open one audio path: load the worklets, ask for the microphone, and build
 * the {@link VoiceIO} wired to `callbacks`.
 *
 * Rejects when any of the three refuses — a denied mic prompt being the
 * ordinary case. The caller owns closing what this resolves: a path that comes
 * up for a connection nobody wants any more is a live microphone, and no
 * amount of cancellation upstream releases the device.
 */
export async function openAudioPath(
  config: AudioPathConfig,
  callbacks: AudioPathCallbacks,
): Promise<VoiceIO> {
  const [{ createVoiceIO }, captureWorklet, playbackWorklet] = await loadAudioModules();
  return createVoiceIO({
    sttSampleRate: config.sampleRate,
    ttsSampleRate: config.ttsSampleRate,
    captureWorkletSrc: captureWorklet,
    playbackWorkletSrc: playbackWorklet,
    onMicData: callbacks.onMicData,
    // Close the host's playback loop. Without this the host models playback
    // open-loop — every forwarded chunk assumed to start playing on arrival
    // at exactly 1.0x — so a buffer that has run ahead of the wall clock is
    // invisible to it, and it opens the speaking-edge gate, retires the
    // barge-in floor, and records words as heard while the caller is still
    // listening to them.
    onPlaybackProgress: callbacks.onProgress,
    // A worklet processor crash after setup: the audio path is dead even
    // though the socket is fine, so surface it instead of staying in a
    // healthy-looking listening/speaking state forever.
    onError: (err: Error) => callbacks.onFailure(err.message),
  });
}
