// Copyright 2026 the AAI authors. MIT license.
/**
 * The session core's side of the audio path: every socket frame and snapshot
 * write the statechart decides on but cannot make itself.
 *
 * The split is the one `s2s-lifecycle.ts` draws in the runtime. WHEN a
 * microphone opens, whether an opening is still wanted, and where audio goes
 * before there is anywhere to play it are `session-core-audio-state.ts`'s;
 * this module is HOW — and it is the only half that touches `conn`, the
 * snapshot, or the wire, which is what lets the machine be specced without a
 * browser.
 */

import type { SessionCommand } from "@alexkroman1/aai/protocol";
import type { VoiceIO } from "./audio.ts";
import { openAudioPath } from "./session-core-audio-setup.ts";
import type { AudioPathEffects } from "./session-core-audio-state.ts";
import type { SessionStateMachine } from "./session-core-state.ts";
import { type ConnState, type SessionSnapshot, STOPPED } from "./session-core-types.ts";

/** What the audio effects need from the owning session core. */
export type AudioEffectsDeps = {
  conn: ConnState;
  updateState: (partial: Partial<SessionSnapshot>) => void;
  /** The session's state and error, as one fact — see `session-core-state.ts`. */
  agentState: SessionStateMachine;
  sendJson: (msg: SessionCommand) => void;
  sendAudio: (bytes: ArrayBuffer) => void;
};

/** Build the effects for one session's audio path. */
export function createAudioEffects(deps: AudioEffectsDeps): AudioPathEffects {
  const { conn, updateState, agentState, sendJson, sendAudio } = deps;

  /**
   * Wait for `io`'s playback queue to drain, then go back to listening.
   *
   * Captures `conn.turn` so a completion (or failure) landing after a turn
   * boundary — a barge-in, a committed user turn, an audio-path teardown — is
   * discarded instead of overwriting the newer turn's, or a dead session's,
   * state.
   */
  function settleWhenDrained(io: VoiceIO): void {
    const at = conn.turn.current();
    void io
      .done()
      .then(() => {
        if (!conn.turn.isCurrent(at)) return;
        updateState(agentState.apply({ type: "LISTEN" }));
      })
      .catch((err: unknown) => {
        console.warn("Audio playback done failed:", err);
      });
  }

  return {
    open: openAudioPath,
    sendMicAudio: (pcm16) => {
      try {
        sendAudio(pcm16);
      } catch {
        console.debug("[aai-ui] sendAudio dropped: connection closed");
      }
    },
    reportProgress: (bufferedMs) => {
      try {
        sendJson({ type: "playback_progress", bufferedMs });
      } catch {
        /* connection closed — the host falls back to its own estimate */
      }
    },
    announceReady: () => sendJson({ type: "audio_ready" }),
    micLive: () => updateState({ recording: true }),
    listen: () => updateState(agentState.apply({ type: "LISTEN" })),
    settleWhenDrained,
    reportFailure: (message) => {
      // The dead audio path is already released by the machine — a
      // playback-worklet crash must not leave the healthy capture worklet
      // streaming into the socket with the mic indicator lit.
      //
      // `FAILED`, not `FATAL`: the socket may well still be fine, so a later
      // server frame is allowed to recover this banner. See
      // `session-core-state.ts`.
      updateState({
        ...agentState.apply({ type: "FAILED", error: { code: "audio", message, fatal: false } }),
        ...STOPPED,
      });
    },
    // Closing the AudioContext is what makes a pending `done()` resolve, so
    // without this bump the drain's continuation lands on a session that has
    // already gone disconnected/errored and stamps `state: "listening"` over it.
    endTurn: () => conn.turn.bump(),
    release: (io) => {
      void io.close().catch(() => {
        /* already tearing down — nothing to report the failure to */
      });
    },
  };
}
