// Copyright 2025 the AAI authors. MIT license.
/**
 * AssemblyAI Universal-Streaming STT opener (host-only).
 *
 * The user-facing descriptor factory (`assemblyAI(...)`) lives in
 * `sdk/providers/stt/assemblyai.ts`. This module is the host-side
 * counterpart: it takes the descriptor options + an API key and
 * returns an {@link SttOpener} that the pipeline session drives.
 *
 * Default model: `"u3pro-rt"` (Universal-3 Pro Real-Time). The adapter
 * maps that to the SDK's `"u3-rt-pro"` `speechModel` value; any other
 * string is forwarded verbatim.
 */

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

/** Internal: SttSession with a test-only handle to the raw SDK transcriber. */
export interface AssemblyAISession extends SttSession {
  /** @internal Test-only: exposes the underlying SDK transcriber for fixture replay. */
  readonly _transcriber: StreamingTranscriber;
}

/** Translate the descriptor's model alias to the SDK's `speechModel` value. */
function resolveSpeechModel(model: string): string {
  // Plan's public name is "u3pro-rt"; the SDK's enum uses "u3-rt-pro".
  if (model === "u3pro-rt") return "u3-rt-pro";
  return model;
}

/** Build an {@link SttOpener} from resolved AssemblyAI descriptor options. */
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
        // The SDK types `speechModel` as a string-literal union; the adapter
        // accepts `string` as an escape hatch, so cast at the boundary.
        speechModel: speechModel as never,
        ...(openOpts.sttPrompt ? { prompt: openOpts.sttPrompt } : {}),
      });

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      let closed = false;

      transcriber.on("turn", (event) => {
        if (closed) return;
        const text = event.transcript ?? "";
        if (event.end_of_turn) {
          if (text.length > 0) emitter.emit("final", text);
        } else if (text.length > 0) {
          emitter.emit("partial", text);
        }
      });

      transcriber.on("error", (err) => {
        if (closed) return;
        emitter.emit("error", makeSttError("stt_stream_error", err?.message ?? String(err)));
      });

      transcriber.on("close", (code) => {
        if (closed) return;
        // 1000 = normal closure.
        if (code !== 1000) {
          emitter.emit("error", makeSttError("stt_stream_error", `socket closed ${code}`));
        }
      });

      try {
        await transcriber.connect();
      } catch (cause) {
        throw makeSttError(
          "stt_connect_failed",
          `AssemblyAI STT: connect failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
          await transcriber.close();
        } catch {
          // Swallow: the caller has already decided to tear down.
        }
      };

      if (openOpts.signal.aborted) {
        void close();
      } else {
        openOpts.signal.addEventListener("abort", () => void close(), {
          once: true,
        });
      }

      const session: AssemblyAISession = {
        sendAudio(pcm: Int16Array) {
          if (closed) return;
          const copy = new Uint8Array(pcm.byteLength);
          copy.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
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
