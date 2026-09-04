// Copyright 2026 the AAI authors. MIT license.
/**
 * ElevenLabs Scribe streaming STT opener (host-only).
 *
 * The user-facing descriptor factory (`elevenlabs(...)`) lives in
 * `sdk/providers/stt/elevenlabs.ts`. This module is the host-side
 * counterpart: it takes the descriptor options + an API key and
 * returns an {@link SttOpener} that the pipeline session drives.
 *
 * Default model: `"scribe_v2_realtime"`. Audio is sent as base64-encoded
 * PCM_16000; partial transcripts arrive on `transcript`, finals on
 * `committed_transcript`.
 */

import {
  createSttError,
  ELEVENLABS_API_KEY_ENV,
  resolveElevenLabsSttSettings,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "@alexkroman1/aai/host-internal";
import type { ElevenLabsSttOptions } from "@alexkroman1/aai/stt";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import {
  AudioFormat,
  CommitStrategy,
  RealtimeEvents,
} from "@elevenlabs/elevenlabs-js/wrapper/realtime/index.js";
import { createNanoEvents, type Emitter } from "nanoevents";
import { uint8ToBase64 } from "../../_base64.ts";
import { pcm16ToBytes } from "../../_pcm.ts";
import {
  assertPcm16Rate,
  closeAfterFlush,
  closeOnAbort,
  connectOrThrow,
  createPcmFrameAccumulator,
  createSttSessionShell,
  type Pcm16Rate,
  requireApiKey,
} from "../_utils.ts";

/** Map a numeric sample rate to the SDK's `AudioFormat` enum. */
const AUDIO_FORMATS: Record<Pcm16Rate, AudioFormat> = {
  8000: AudioFormat.PCM_8000,
  16000: AudioFormat.PCM_16000,
  22050: AudioFormat.PCM_22050,
  24000: AudioFormat.PCM_24000,
  44100: AudioFormat.PCM_44100,
  48000: AudioFormat.PCM_48000,
};

function audioFormatFor(sampleRate: number): AudioFormat {
  return AUDIO_FORMATS[
    assertPcm16Rate(sampleRate, "ElevenLabs STT", (msg) =>
      createSttError("stt_connect_failed", msg),
    )
  ];
}

/** Build an {@link SttOpener} from resolved ElevenLabs descriptor options. */
export function openElevenLabs(opts: ElevenLabsSttOptions = {}): SttOpener {
  return {
    name: "elevenlabs",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(
        openOpts.apiKey,
        ELEVENLABS_API_KEY_ENV,
        "ElevenLabs STT",
        (msg) => createSttError("stt_auth_failed", msg),
      );

      const settings = resolveElevenLabsSttSettings(opts);
      const client = new ElevenLabsClient({ apiKey });

      const connection = await connectOrThrow(
        "ElevenLabs STT",
        (msg) => createSttError("stt_connect_failed", msg),
        () =>
          client.speechToText.realtime.connect({
            modelId: settings.model,
            audioFormat: audioFormatFor(openOpts.sampleRate),
            sampleRate: openOpts.sampleRate,
            commitStrategy: CommitStrategy.VAD,
            ...(settings.languageCode ? { languageCode: settings.languageCode } : {}),
          }),
      );

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      const shell = createSttSessionShell({
        emitter,
        teardown: () => connection.close(),
      });

      // Emit through the shell's containment: these fire from inside the SDK's
      // event handler, so a listener that throws would escape as an
      // uncaughtException, and nothing may be emitted once the session closed.
      function emitTranscript(event: "partial" | "final", text: string | undefined) {
        if (text && text.length > 0) shell.emit(event, text);
      }

      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (msg) => {
        emitTranscript("partial", msg.text);
      });

      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (msg) => {
        emitTranscript("final", msg.text);
      });

      connection.on(RealtimeEvents.ERROR, (payload) => {
        // Payload is either a server ErrorMessage variant ({ message_type, error })
        // or a native WebSocket Error.
        const msg =
          payload instanceof Error ? payload.message : (payload.error ?? `${payload.message_type}`);
        shell.streamError(msg);
      });

      connection.on(RealtimeEvents.AUTH_ERROR, (msg) => {
        shell.emit("error", createSttError("stt_auth_failed", msg.error));
      });

      closeOnAbort(openOpts.signal, shell.close);

      // Base64-encoding and JSON-wrapping every ~20 ms mic frame is ~50
      // provider messages per second; coalesce to ~100 ms frames first (see
      // createPcmFrameAccumulator). ElevenLabs has no frame floor, so the
      // close-time flush forwards any remaining tail (minFlushMs: 0).
      const frames = createPcmFrameAccumulator({
        sampleRate: openOpts.sampleRate,
        minFlushMs: 0,
        // The SDK expects base64-encoded audio; pcm16ToBytes views the
        // accumulator's own backing buffer and the encode copies out of it, so
        // nothing retains the view past the call.
        send: (frame) => connection.send({ audioBase64: uint8ToBase64(pcm16ToBytes(frame)) }),
      });

      return {
        // No backpressure gate here (unlike the other STT openers): the
        // ElevenLabs SDK keeps its WebSocket private with no buffered-amount
        // accessor, so a stalled link cannot be observed from this side.
        sendAudio(pcm: Int16Array) {
          if (shell.isClosed()) return;
          frames.push(pcm);
        },
        on: shell.on,
        close: closeAfterFlush(shell, frames),
      };
    },
  };
}
