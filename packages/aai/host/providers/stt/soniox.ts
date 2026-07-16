// Copyright 2026 the AAI authors. MIT license.

import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import { SONIOX_API_KEY_ENV, type SonioxOptions } from "../../../sdk/providers/stt/soniox.ts";
import {
  makeSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../../../sdk/providers.ts";
import {
  closeOnAbort,
  connectOrThrow,
  createSessionShell,
  requireApiKey,
  waitForOpen,
} from "../_utils.ts";

// `@soniox/speech-to-text-web` is browser-only (MediaRecorder/getUserMedia),
// so we speak the WebSocket protocol directly.
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

interface SonioxToken {
  text?: string;
  is_final?: boolean;
}

interface SonioxResponse {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number;
  error_message?: string;
}

function consumeTokens(tokens: SonioxToken[], appendFinal: (text: string) => void): string {
  let nonFinal = "";
  for (const tok of tokens) {
    const text = tok.text ?? "";
    if (text.length === 0) continue;
    if (tok.is_final) {
      appendFinal(text);
    } else {
      nonFinal += text;
    }
  }
  return nonFinal;
}

function buildConfigFrame(
  apiKey: string,
  opts: SonioxOptions,
  sampleRate: number,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    api_key: apiKey,
    model: opts.model ?? "stt-rt-v3",
    audio_format: "pcm_s16le",
    sample_rate: sampleRate,
    num_channels: 1,
  };
  if (opts.languageHints && opts.languageHints.length > 0) {
    config.language_hints = [...opts.languageHints];
  }
  return config;
}

function parseFrame(raw: WebSocket.RawData): SonioxResponse | null {
  try {
    return JSON.parse(raw.toString()) as SonioxResponse;
  } catch {
    return null;
  }
}

function handleResponse(
  res: SonioxResponse,
  emitter: Emitter<SttEvents>,
  finalBuf: { value: string },
): void {
  if (res.error_code !== undefined) {
    emitter.emit(
      "error",
      makeSttError(
        "stt_stream_error",
        `Soniox error ${res.error_code}: ${res.error_message ?? "unknown"}`,
      ),
    );
    return;
  }
  if (!res.tokens || res.tokens.length === 0) return;
  const nonFinal = consumeTokens(res.tokens, (text) => {
    finalBuf.value += text;
  });
  // Batch contiguous finals into one `final` event by flushing only when
  // a new non-final preview starts (or the session finishes).
  if (finalBuf.value.length > 0 && (nonFinal.length > 0 || res.finished)) {
    emitter.emit("final", finalBuf.value);
    finalBuf.value = "";
  }
  if (nonFinal.length > 0) {
    emitter.emit("partial", nonFinal);
  }
}

export function openSoniox(opts: SonioxOptions = {}): SttOpener {
  return {
    name: "soniox",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(openOpts.apiKey, SONIOX_API_KEY_ENV, "Soniox STT", (msg) =>
        makeSttError("stt_auth_failed", msg),
      );

      const ws = new WebSocket(SONIOX_WS_URL);
      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      const finalBuf = { value: "" };

      const shell = createSessionShell({
        makeStreamError: (msg) => makeSttError("stt_stream_error", msg),
        emitError: (err) => emitter.emit("error", err),
        teardown: () => {
          // Flush any batched finals so the last utterance isn't dropped.
          if (finalBuf.value.length > 0) {
            emitter.emit("final", finalBuf.value);
            finalBuf.value = "";
          }
          ws.close();
          // Drop our handlers so their closures (emitter/finalBuf/shell) don't
          // stay reachable via the socket if `ws` outlives this session.
          ws.removeAllListeners();
        },
      });

      await connectOrThrow(
        "Soniox STT",
        (msg) => makeSttError("stt_connect_failed", msg),
        () => waitForOpen(ws),
      );

      ws.send(JSON.stringify(buildConfigFrame(apiKey, opts, openOpts.sampleRate)));

      ws.on("message", (raw: WebSocket.RawData) => {
        if (shell.isClosed()) return;
        const res = parseFrame(raw);
        if (res) handleResponse(res, emitter, finalBuf);
      });

      ws.on("error", (err: Error) => shell.onSocketError(err));
      ws.on("close", (code: number) => shell.onSocketClose(code));

      closeOnAbort(openOpts.signal, shell.close);

      return {
        sendAudio(pcm: Int16Array) {
          if (shell.isClosed() || ws.readyState !== WebSocket.OPEN) return;
          // Pass the underlying buffer to avoid a copy.
          ws.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), { binary: true });
        },
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close: shell.close,
      };
    },
  };
}
