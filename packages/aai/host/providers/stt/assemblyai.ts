// Copyright 2025 the AAI authors. MIT license.

import { AssemblyAI, type StreamingTranscriber } from "assemblyai";
import { createNanoEvents, type Emitter } from "nanoevents";
import type { AssemblyAIOptions } from "../../../sdk/providers/stt/assemblyai.ts";
import {
  makeSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../../../sdk/providers.ts";
import { errorMessage } from "../../../sdk/utils.ts";

export interface AssemblyAISession extends SttSession {
  /** @internal Test-only: exposes the underlying SDK transcriber for fixture replay. */
  readonly _transcriber: StreamingTranscriber;
}

function resolveSpeechModel(model: string): string {
  // Plan's public name is "u3pro-rt"; the SDK's enum uses "u3-rt-pro".
  return model === "u3pro-rt" ? "u3-rt-pro" : model;
}

export function openAssemblyAI(opts: AssemblyAIOptions = {}): SttOpener {
  return {
    name: "assemblyai",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = openOpts.apiKey || process.env.ASSEMBLYAI_API_KEY;
      if (!apiKey) {
        throw makeSttError(
          "stt_auth_failed",
          "AssemblyAI STT: missing API key. Set ASSEMBLYAI_API_KEY in the agent env.",
        );
      }

      const client = new AssemblyAI({ apiKey });
      const speechModel = resolveSpeechModel(opts.model ?? "u3pro-rt");
      const transcriber = client.streaming.transcriber({
        sampleRate: openOpts.sampleRate,
        // SDK types `speechModel` as a string-literal union; accept `string` here.
        speechModel: speechModel as never,
        ...(openOpts.sttPrompt ? { prompt: openOpts.sttPrompt } : {}),
      });

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      let closed = false;

      transcriber.on("turn", (event) => {
        if (closed) return;
        const text = event.transcript ?? "";
        if (text.length === 0) return;
        emitter.emit(event.end_of_turn ? "final" : "partial", text);
      });

      transcriber.on("error", (err) => {
        if (closed) return;
        emitter.emit("error", makeSttError("stt_stream_error", err?.message ?? String(err)));
      });

      transcriber.on("close", (code) => {
        if (closed || code === 1000) return;
        emitter.emit("error", makeSttError("stt_stream_error", `socket closed ${code}`));
      });

      try {
        await transcriber.connect();
      } catch (cause) {
        throw makeSttError(
          "stt_connect_failed",
          `AssemblyAI STT: connect failed: ${errorMessage(cause)}`,
        );
      }

      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
          await transcriber.close();
        } catch {
          // Caller is tearing down; nothing to do on close failure.
        }
      };

      if (openOpts.signal.aborted) {
        void close();
      } else {
        openOpts.signal.addEventListener("abort", () => void close(), { once: true });
      }

      const session: AssemblyAISession = {
        sendAudio(pcm: Int16Array) {
          if (closed) return;
          // Copy: caller may reuse `pcm`'s backing buffer for the next chunk.
          const copy = new Uint8Array(
            pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
          );
          transcriber.sendAudio(copy.buffer);
        },
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close,
        _transcriber: transcriber,
      };

      return session;
    },
  };
}
