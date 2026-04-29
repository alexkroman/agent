// Copyright 2026 the AAI authors. MIT license.

import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import type { SonioxOptions } from "../../../sdk/providers/stt/soniox.ts";
import {
  makeSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../../../sdk/providers.ts";

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

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = (): void => {
      ws.off("error", onErr);
      resolve();
    };
    const onErr = (err: Error): void => {
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onErr);
  });
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
      const apiKey = openOpts.apiKey || process.env.SONIOX_API_KEY;
      if (!apiKey) {
        throw makeSttError(
          "stt_auth_failed",
          "Soniox STT: missing API key. Set SONIOX_API_KEY in the agent env.",
        );
      }

      const ws = new WebSocket(SONIOX_WS_URL);
      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      let closed = false;
      const finalBuf = { value: "" };

      try {
        await waitForOpen(ws);
      } catch (cause) {
        throw makeSttError(
          "stt_connect_failed",
          `Soniox STT: connect failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      ws.send(JSON.stringify(buildConfigFrame(apiKey, opts, openOpts.sampleRate)));

      ws.on("message", (raw: WebSocket.RawData) => {
        if (closed) return;
        const res = parseFrame(raw);
        if (res) handleResponse(res, emitter, finalBuf);
      });

      ws.on("error", (err: Error) => {
        if (closed) return;
        emitter.emit("error", makeSttError("stt_stream_error", err.message ?? String(err)));
      });

      ws.on("close", (code: number) => {
        if (closed) return;
        if (code !== 1000) {
          emitter.emit("error", makeSttError("stt_stream_error", `socket closed ${code}`));
        }
      });

      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        if (finalBuf.value.length > 0) {
          emitter.emit("final", finalBuf.value);
          finalBuf.value = "";
        }
        try {
          ws.close();
        } catch {
          // Caller is tearing down; ws.close errors are not actionable.
        }
      };

      if (openOpts.signal.aborted) {
        void close();
      } else {
        openOpts.signal.addEventListener("abort", () => void close(), { once: true });
      }

      return {
        sendAudio(pcm: Int16Array) {
          if (closed || ws.readyState !== WebSocket.OPEN) return;
          // Pass the underlying buffer to avoid a copy.
          ws.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), { binary: true });
        },
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close,
      };
    },
  };
}
