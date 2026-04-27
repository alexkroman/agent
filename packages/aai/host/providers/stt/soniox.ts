// Copyright 2026 the AAI authors. MIT license.
/**
 * Soniox real-time STT opener (host-only).
 *
 * The user-facing descriptor factory (`soniox(...)`) lives in
 * `sdk/providers/stt/soniox.ts`. This module is the host-side
 * counterpart: it takes the descriptor options + an API key and
 * returns an {@link SttOpener} that the pipeline session drives.
 *
 * Soniox's published JS client (`@soniox/speech-to-text-web`) is
 * browser-only — it depends on `MediaRecorder` and `getUserMedia`. For
 * server-side use we talk to the WebSocket directly:
 *   `wss://stt-rt.soniox.com/transcribe-websocket`
 *
 * Wire format:
 *   - First text frame: JSON config with api_key, model, audio_format,
 *     sample_rate, num_channels (and optional language hints).
 *   - Subsequent binary frames: 16-bit signed little-endian PCM audio.
 *   - Server replies: JSON `{ tokens: [{ text, is_final }] }` messages.
 *     Final tokens accumulate; non-final tokens are a rolling preview.
 *   - On error: `{ error_code, error_message }`.
 */

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

const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

/** Soniox token shape from the wire protocol. */
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

/**
 * Walk a batch of Soniox tokens, sending finals into `appendFinal` and
 * returning the concatenated non-finals as a rolling preview string.
 */
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

/** Resolve once the WebSocket opens; reject on the first error. */
function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.off("error", onErr);
      resolve();
    };
    const onErr = (err: Error) => {
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onErr);
  });
}

/** Build the initial JSON config frame for a Soniox session. */
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

/** Parse a Soniox text frame into a {@link SonioxResponse}; returns null on garbage. */
function parseFrame(raw: WebSocket.RawData): SonioxResponse | null {
  try {
    return JSON.parse(raw.toString()) as SonioxResponse;
  } catch {
    return null;
  }
}

/**
 * Handle one server response. Emits `error`, `final`, and `partial` events
 * onto `emitter` based on the token batch and the running `finalBuf`. The
 * caller owns `finalBuf` so it survives across messages and can be flushed
 * on close.
 */
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
  // Flush an accumulated final whenever the next batch's non-final preview
  // begins (or when the session finishes). This batches contiguous final
  // tokens into a single `final` event, matching what downstream pipeline
  // session code expects.
  if (finalBuf.value.length > 0 && (nonFinal.length > 0 || res.finished)) {
    emitter.emit("final", finalBuf.value);
    finalBuf.value = "";
  }
  if (nonFinal.length > 0) {
    emitter.emit("partial", nonFinal);
  }
}

/** Build an {@link SttOpener} from resolved Soniox descriptor options. */
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
      // Soniox emits final tokens once and non-final tokens repeatedly. We
      // accumulate finals into a buffer flushed on each non-final boundary
      // and forward non-finals as the rolling partial. Mirrors how the
      // existing AssemblyAI/Deepgram openers map provider-specific token
      // streams onto the SttEvents `partial`/`final` contract.
      const finalBuf = { value: "" };

      try {
        await waitForOpen(ws);
      } catch (cause) {
        throw makeSttError(
          "stt_connect_failed",
          `Soniox STT: connect failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      // Initial config frame (text). Sent first; audio binary frames follow.
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
        // 1000 = normal closure.
        if (code !== 1000) {
          emitter.emit("error", makeSttError("stt_stream_error", `socket closed ${code}`));
        }
      });

      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        // Flush any trailing final tokens that arrived right before close.
        if (finalBuf.value.length > 0) {
          emitter.emit("final", finalBuf.value);
          finalBuf.value = "";
        }
        try {
          ws.close();
        } catch {
          // Swallow: caller has already decided to tear down.
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
          // Sending the underlying buffer directly avoids a copy. ws will
          // hand it to the OS as a binary frame.
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
