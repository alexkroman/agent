// Copyright 2025 the AAI authors. MIT license.

/**
 * Audio-path initialization for the voice session core.
 *
 * Split out of `session-core.ts`: this module owns the async
 * mic-permission → worklet-registration → `VoiceIO` bring-up (and its
 * staleness/failure handling), while `session-core.ts` owns the state store
 * and connection lifecycle.
 */

import { errorMessage, WS_OPEN } from "@alexkroman1/aai";
import type { ClientMessage } from "@alexkroman1/aai/protocol";
import type { VoiceIO } from "./audio.ts";
import type { ConnState, SessionSnapshot } from "./session-core-types.ts";

/** Dependencies `initAudioCapture` needs from the owning session core. */
export type AudioSetupDeps = {
  sendJson: (msg: ClientMessage) => void;
  sendAudio: (bytes: Uint8Array) => void;
  updateState: (partial: Partial<SessionSnapshot>) => void;
  /** Turn-boundary-guarded drain from the message handlers — replays a
   *  buffered `audio_done` without stomping a barge-in's state. */
  settleWhenAudioDrained: (io: VoiceIO) => void;
  /** Release the mic/VoiceIO (used when the audio path dies non-fatally). */
  cleanupAudio: () => void;
};

/**
 * Initialize audio capture and playback after the server sends a ready config.
 *
 * Lifecycle: dynamically import audio modules -> request microphone access ->
 * register AudioWorklet processors -> create a `VoiceIO` instance -> send
 * `audio_ready` to the server -> transition state to `"listening"`.
 *
 * Uses the connection `generation` counter to detect if `connect()` was called
 * (or a reconnect happened) while awaiting async operations; if so, the stale
 * VoiceIO is closed immediately to prevent it from being assigned to a newer
 * connection.
 *
 * `fatal` selects the failure mode: voice sessions (`config` handshake) can't
 * function without the mic, so failure there sets the error state and ends
 * the session; a text-only session's opt-in record button must not brick an
 * otherwise healthy session, so failure there is a banner (`error` set,
 * state kept) and the session stays interactive.
 */
export async function initAudioCapture(
  conn: ConnState,
  msg: { sampleRate: number; ttsSampleRate: number },
  deps: AudioSetupDeps,
  fatal: boolean,
): Promise<void> {
  if (conn.audioSetupInFlight) return;
  conn.audioSetupInFlight = true;
  const gen = conn.generation;
  const stale = (): boolean =>
    conn.generation !== gen || !conn.ws || conn.ws.readyState !== WS_OPEN;
  const reportAudioFailure = (message: string): void => {
    if (fatal) {
      deps.updateState({
        state: "error",
        error: { code: "audio", message },
        running: false,
        recording: false,
      });
    } else {
      // The session survives: show the banner, release the dead audio path,
      // and leave the socket (and text/upload controls) usable.
      deps.cleanupAudio();
      deps.updateState({ error: { code: "audio", message }, recording: false });
    }
  };
  try {
    const [{ createVoiceIO }, captureWorklet, playbackWorklet] = await Promise.all([
      import("./audio.ts"),
      import("./worklets/capture-processor.ts").then((m) => m.default),
      import("./worklets/playback-processor.ts").then((m) => m.default),
    ]);
    const io = await createVoiceIO({
      sttSampleRate: msg.sampleRate,
      ttsSampleRate: msg.ttsSampleRate,
      captureWorkletSrc: captureWorklet,
      playbackWorkletSrc: playbackWorklet,
      onMicData: (pcm16: ArrayBuffer) => {
        try {
          deps.sendAudio(new Uint8Array(pcm16));
        } catch {
          console.debug("[aai-ui] sendAudio dropped: connection closed");
        }
      },
      // Underruns are otherwise completely silent: the session still reports
      // "speaking" and done() still settles normally, so a reply that came
      // out in fragments leaves no trace anywhere. Only turns that actually
      // concealed something reach this callback.
      onPlaybackStats: (stats) => {
        console.warn("[aai-ui] playback concealed a gap in this turn", stats);
      },
      // A worklet processor crash after setup: the audio path is dead even
      // though the socket is fine, so surface it instead of staying in a
      // healthy-looking listening/speaking state forever.
      onError: (err: Error) => {
        if (conn.generation !== gen) return;
        reportAudioFailure(err.message);
      },
    });
    if (stale()) {
      void io.close().catch(() => {
        /* stale connection — nothing to report the failure to */
      });
      return;
    }
    // Defensive: if a previous VoiceIO somehow survived to this point, close
    // it before overwriting the slot — an orphaned instance keeps its mic
    // tracks live and pumps duplicate audio.
    void conn.voiceIO?.close().catch(() => {
      /* already closing */
    });
    conn.voiceIO = io;
    if (conn.preInitAudio.length > 0) {
      for (const chunk of conn.preInitAudio) {
        io.enqueue(chunk.buffer as ArrayBuffer);
      }
      conn.preInitAudio = [];
    }
    deps.sendJson({ type: "audio_ready" });
    deps.updateState({ recording: true });
    // If audio_done arrived while we were initializing, replay it now so the
    // buffered greeting plays to completion (and state flips to "listening"
    // only when playback actually drains) instead of the done being lost.
    if (conn.preInitDone) {
      conn.preInitDone = false;
      deps.settleWhenAudioDrained(io);
    } else {
      deps.updateState({ state: "listening" });
    }
  } catch (err: unknown) {
    if (stale()) return;
    reportAudioFailure(`Microphone access failed: ${errorMessage(err)}`);
  } finally {
    // Only the init that still owns the flag may clear it: a stale
    // generation's settle must not unlock a newer init that is in flight
    // (which would let a second same-generation init start and orphan a
    // live microphone).
    if (conn.generation === gen) conn.audioSetupInFlight = false;
  }
}
