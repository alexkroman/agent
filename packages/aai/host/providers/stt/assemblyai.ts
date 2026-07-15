// Copyright 2025 the AAI authors. MIT license.

import { AssemblyAI, type StreamingTranscriber } from "assemblyai";
import { createNanoEvents, type Emitter } from "nanoevents";
import {
  ASSEMBLYAI_API_KEY_ENV,
  type AssemblyAIOptions,
} from "../../../sdk/providers/stt/assemblyai.ts";
import {
  makeSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../../../sdk/providers.ts";
import { closeOnAbort, connectOrThrow, createSessionShell, requireApiKey } from "../_utils.ts";

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
      const apiKey = requireApiKey(
        openOpts.apiKey,
        ASSEMBLYAI_API_KEY_ENV,
        "AssemblyAI STT",
        (msg) => makeSttError("stt_auth_failed", msg),
      );

      const client = new AssemblyAI({ apiKey });
      const speechModel = resolveSpeechModel(opts.model ?? "u3pro-rt");
      const transcriber = client.streaming.transcriber({
        sampleRate: openOpts.sampleRate,
        // SDK types `speechModel` as a string-literal union; accept `string` here.
        speechModel: speechModel as never,
        ...(openOpts.sttPrompt ? { prompt: openOpts.sttPrompt } : {}),
      });

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      const shell = createSessionShell({
        makeStreamError: (msg) => makeSttError("stt_stream_error", msg),
        emitError: (err) => emitter.emit("error", err),
        teardown: () => transcriber.close(),
      });

      transcriber.on("turn", (event) => {
        if (shell.isClosed()) return;
        const text = event.transcript ?? "";
        if (text.length === 0) return;
        emitter.emit(event.end_of_turn ? "final" : "partial", text);
      });

      transcriber.on("error", (err) => shell.onSocketError(err));
      transcriber.on("close", (code) => shell.onSocketClose(code));

      await connectOrThrow(
        "AssemblyAI STT",
        (msg) => makeSttError("stt_connect_failed", msg),
        () => transcriber.connect(),
      );

      closeOnAbort(openOpts.signal, shell.close);

      const session: AssemblyAISession = {
        sendAudio(pcm: Int16Array) {
          if (shell.isClosed()) return;
          // Copy: caller may reuse `pcm`'s backing buffer for the next chunk.
          const copy = new Uint8Array(
            pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
          );
          transcriber.sendAudio(copy.buffer);
        },
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close: shell.close,
        _transcriber: transcriber,
      };

      return session;
    },
  };
}
