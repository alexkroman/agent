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

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import {
  AudioFormat,
  CommitStrategy,
  RealtimeEvents,
} from "@elevenlabs/elevenlabs-js/wrapper/realtime/index.js";
import { createNanoEvents, type Emitter } from "nanoevents";
import {
  ELEVENLABS_API_KEY_ENV,
  type ElevenLabsOptions,
} from "../../../sdk/providers/stt/elevenlabs.ts";
import {
  makeSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../../../sdk/providers.ts";
import { uint8ToBase64 } from "../../_base64.ts";
import {
  assertPcm16Rate,
  closeOnAbort,
  connectOrThrow,
  createPcmFrameAccumulator,
  createSessionShell,
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
    assertPcm16Rate(sampleRate, "ElevenLabs STT", (msg) => makeSttError("stt_connect_failed", msg))
  ];
}

/** Build an {@link SttOpener} from resolved ElevenLabs descriptor options. */
export function openElevenLabs(opts: ElevenLabsOptions = {}): SttOpener {
  return {
    name: "elevenlabs",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(
        openOpts.apiKey,
        ELEVENLABS_API_KEY_ENV,
        "ElevenLabs STT",
        (msg) => makeSttError("stt_auth_failed", msg),
      );

      const client = new ElevenLabsClient({ apiKey });

      const connection = await connectOrThrow(
        "ElevenLabs STT",
        (msg) => makeSttError("stt_connect_failed", msg),
        () =>
          client.speechToText.realtime.connect({
            modelId: opts.model ?? "scribe_v2_realtime",
            audioFormat: audioFormatFor(openOpts.sampleRate),
            sampleRate: openOpts.sampleRate,
            commitStrategy: CommitStrategy.VAD,
            ...(opts.languageCode ? { languageCode: opts.languageCode } : {}),
          }),
      );

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      const shell = createSessionShell({
        makeStreamError: (msg) => makeSttError("stt_stream_error", msg),
        emitError: (err) => emitter.emit("error", err),
        teardown: () => connection.close(),
      });

      function emitTranscript(event: "partial" | "final", text: string | undefined) {
        if (shell.isClosed()) return;
        if (text && text.length > 0) emitter.emit(event, text);
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
        if (shell.isClosed()) return;
        emitter.emit("error", makeSttError("stt_auth_failed", msg.error));
      });

      closeOnAbort(openOpts.signal, shell.close);

      // Base64-encoding and JSON-wrapping every ~20 ms mic frame is ~50
      // provider messages per second; coalesce to ~100 ms frames first (see
      // createPcmFrameAccumulator). ElevenLabs has no frame floor, so the
      // close-time flush forwards any remaining tail (minFlushMs: 0).
      const frames = createPcmFrameAccumulator({
        sampleRate: openOpts.sampleRate,
        minFlushMs: 0,
        // The SDK expects base64-encoded audio; uint8ToBase64 encodes a
        // zero-copy view over the accumulator's backing buffer (the encode
        // itself copies, so the view is not retained past the call).
        send: (frame) =>
          connection.send({
            audioBase64: uint8ToBase64(
              new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
            ),
          }),
      });

      return {
        sendAudio(pcm: Int16Array) {
          if (shell.isClosed()) return;
          frames.push(pcm);
        },
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close: () => {
          if (!shell.isClosed()) frames.flush();
          return shell.close();
        },
      };
    },
  };
}
