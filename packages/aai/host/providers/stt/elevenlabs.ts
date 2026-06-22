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
import type { ElevenLabsOptions } from "../../../sdk/providers/stt/elevenlabs.ts";
import {
  makeSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../../../sdk/providers.ts";

/** Map a numeric sample rate to the SDK's `AudioFormat` enum. */
const AUDIO_FORMAT_MAP: Record<number, AudioFormat> = {
  8000: AudioFormat.PCM_8000,
  16000: AudioFormat.PCM_16000,
  22050: AudioFormat.PCM_22050,
  24000: AudioFormat.PCM_24000,
  44100: AudioFormat.PCM_44100,
  48000: AudioFormat.PCM_48000,
};

function audioFormatFor(sampleRate: number): AudioFormat {
  const fmt = AUDIO_FORMAT_MAP[sampleRate];
  if (fmt === undefined) {
    throw makeSttError(
      "stt_connect_failed",
      `ElevenLabs STT: unsupported sample rate ${sampleRate}. Supported: 8000, 16000, 22050, 24000, 44100, 48000.`,
    );
  }
  return fmt;
}

/** Build an {@link SttOpener} from resolved ElevenLabs descriptor options. */
export function openElevenLabs(opts: ElevenLabsOptions = {}): SttOpener {
  return {
    name: "elevenlabs",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = openOpts.apiKey || process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        throw makeSttError(
          "stt_auth_failed",
          "ElevenLabs STT: missing API key. Set ELEVENLABS_API_KEY in the agent env.",
        );
      }

      const client = new ElevenLabsClient({ apiKey });

      let connection: Awaited<ReturnType<typeof client.speechToText.realtime.connect>>;
      try {
        connection = await client.speechToText.realtime.connect({
          modelId: opts.model ?? "scribe_v2_realtime",
          audioFormat: audioFormatFor(openOpts.sampleRate),
          sampleRate: openOpts.sampleRate,
          commitStrategy: CommitStrategy.VAD,
          ...(opts.languageCode !== undefined && { languageCode: opts.languageCode }),
        });
      } catch (cause) {
        throw makeSttError(
          "stt_connect_failed",
          `ElevenLabs STT: connect failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      let closed = false;

      function emitTranscript(event: "partial" | "final", text: string | undefined) {
        if (closed) return;
        if (text) emitter.emit(event, text);
      }

      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (msg) => {
        emitTranscript("partial", msg.text);
      });

      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (msg) => {
        emitTranscript("final", msg.text);
      });

      connection.on(RealtimeEvents.ERROR, (payload) => {
        if (closed) return;
        // Payload is either a server ErrorMessage variant ({ message_type, error })
        // or a native WebSocket Error.
        const msg =
          payload instanceof Error ? payload.message : (payload.error ?? `${payload.message_type}`);
        emitter.emit("error", makeSttError("stt_stream_error", msg));
      });

      connection.on(RealtimeEvents.AUTH_ERROR, (msg) => {
        if (closed) return;
        emitter.emit("error", makeSttError("stt_auth_failed", msg.error));
      });

      async function close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          connection.close();
        } catch {
          // Already tearing down — ignore close errors.
        }
      }

      if (openOpts.signal.aborted) {
        void close();
      } else {
        openOpts.signal.addEventListener("abort", () => void close(), { once: true });
      }

      // Reuse a single wrapper object across all sendAudio calls to avoid
      // per-packet allocations on the ~100 Hz audio hot path.
      const audioMsg: { audioBase64: string } = { audioBase64: "" };

      return {
        sendAudio(pcm: Int16Array) {
          if (closed) return;
          // The SDK expects base64-encoded audio. Avoid an intermediate
          // copy: Buffer.from over the same backing buffer is enough.
          const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
          audioMsg.audioBase64 = bytes.toString("base64");
          connection.send(audioMsg);
        },
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close,
      };
    },
  };
}
