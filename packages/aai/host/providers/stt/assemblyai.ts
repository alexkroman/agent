// Copyright 2025 the AAI authors. MIT license.
/**
 * AssemblyAI Universal-Streaming STT adapter.
 *
 * Wraps the `assemblyai` Node SDK's {@link StreamingTranscriber} and
 * normalizes its event surface onto the {@link SttProvider} /
 * {@link SttEvents} contract consumed by the pipeline orchestrator.
 *
 * Default model: `"u3pro-rt"` (Universal-3 Pro Real-Time). The adapter
 * maps that to the SDK's `"u3-rt-pro"` `speechModel` value; any other
 * string is forwarded verbatim.
 */

import { AssemblyAI, type StreamingTranscriber } from "assemblyai";
import { createNanoEvents, type Emitter } from "nanoevents";
import type {
  SttError,
  SttEvents,
  SttOpenOptions,
  SttProvider,
  SttSession,
} from "../../../sdk/providers.ts";

export interface AssemblyAIOptions {
  /**
   * Streaming speech model. Defaults to `"u3pro-rt"` (Universal-3 Pro
   * Real-Time). Arbitrary strings are forwarded to the SDK unchanged.
   */
  model?: "u3pro-rt" | string;
  /**
   * AssemblyAI API key. Falls back to `SttOpenOptions.apiKey`, then
   * `process.env.ASSEMBLYAI_API_KEY`.
   */
  apiKey?: string;
}

/** Internal: SttSession with a test-only handle to the raw SDK transcriber. */
export interface AssemblyAISession extends SttSession {
  /** @internal Test-only: exposes the underlying SDK transcriber for fixture replay. */
  readonly _transcriber: StreamingTranscriber;
}

/** Translate the adapter's model alias to the SDK's `speechModel` value. */
function resolveSpeechModel(model: string): string {
  // Plan's public name is "u3pro-rt"; the SDK's enum uses "u3-rt-pro".
  if (model === "u3pro-rt") return "u3-rt-pro";
  return model;
}

function makeError(message: string): SttError {
  const err = new Error(message) as SttError & { code: SttError["code"] };
  (err as { code: SttError["code"] }).code = "stt_stream_error";
  return err;
}

export function assemblyAI(opts: AssemblyAIOptions = {}): SttProvider {
  return {
    name: "assemblyai",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = opts.apiKey ?? openOpts.apiKey ?? process.env.ASSEMBLYAI_API_KEY;
      if (!apiKey) {
        const err = new Error(
          "AssemblyAI STT adapter: missing API key. Provide via the factory option, SttOpenOptions, or the ASSEMBLYAI_API_KEY environment variable.",
        ) as SttError & { code: SttError["code"] };
        (err as { code: SttError["code"] }).code = "stt_auth_failed";
        throw err;
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
        emitter.emit("error", makeError(err?.message ?? String(err)));
      });

      transcriber.on("close", (code) => {
        if (closed) return;
        // 1000 = normal closure.
        if (code !== 1000) {
          emitter.emit("error", makeError(`socket closed ${code}`));
        }
      });

      try {
        await transcriber.connect();
      } catch (cause) {
        const err = new Error(
          `AssemblyAI STT: connect failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ) as SttError & { code: SttError["code"] };
        (err as { code: SttError["code"] }).code = "stt_connect_failed";
        throw err;
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

      // Wire session-level abort to close the SDK socket.
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
          // The SDK's sendAudio accepts ArrayBufferLike. Forward a detached
          // copy of the PCM view's window so the consumer sees only this
          // chunk's bytes.
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
