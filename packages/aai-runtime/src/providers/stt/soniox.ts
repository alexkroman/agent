// Copyright 2026 the AAI authors. MIT license.

import {
  createSttError,
  resolveSonioxSttSettings,
  SONIOX_API_KEY_ENV,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "@alexkroman1/aai/host-internal";
import type { SonioxSttOptions } from "@alexkroman1/aai/stt";
import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import { createAudioSendGate } from "../../_audio-gate.ts";
import { pcm16ToBytes } from "../../_pcm.ts";
import { createRestartableTimer } from "../../_timer.ts";
import { PROVIDER_WS_OPTIONS } from "../../_ws.ts";
import { dropSocket, openGuardedWs } from "../_socket.ts";
import { closeOnAbort, createSttSessionShell, requireApiKey } from "../_utils.ts";

// `@soniox/speech-to-text-web` is browser-only (MediaRecorder/getUserMedia),
// so we speak the WebSocket protocol directly.
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

// Quiet window after an all-final frame before flushing the batched final on
// its own. Short enough that turn commit isn't perceptibly delayed, long
// enough to still batch a follow-up final that lands a frame or two later.
const SONIOX_FINAL_FLUSH_MS = 300;

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
  opts: SonioxSttOptions,
  sampleRate: number,
): Record<string, unknown> {
  const settings = resolveSonioxSttSettings(opts);
  const config: Record<string, unknown> = {
    api_key: apiKey,
    model: settings.model,
    audio_format: "pcm_s16le",
    sample_rate: sampleRate,
    num_channels: 1,
  };
  if (settings.languageHints) {
    config.language_hints = [...settings.languageHints];
  }
  return config;
}

/**
 * Read one server frame, or `null` for anything that is not a JSON object.
 *
 * **The parse layer's contract is to drop — never to throw out of the socket's
 * `message` handler**, which would be an uncaughtException taking down a
 * multi-tenant host rather than one session. That is why the shape is probed
 * field by field from here on rather than trusted: the declared interface is a
 * description of what the service sends today, and `safeJsonParse` returns
 * whatever actually arrived.
 */
function parseFrame(raw: WebSocket.RawData): SonioxResponse | null {
  const parsed = safeJsonParse(raw.toString());
  if (!isRecord(parsed)) return null;
  return parsed as SonioxResponse;
}

interface SonioxEmit {
  emitFinal: (text: string) => void;
  emitPartial: (text: string) => void;
  streamError: (message: string) => void;
  /** Arm the flush-on-quiet timer so a trailing final commits without a follow-up utterance. */
  armFlush: () => void;
}

function handleResponse(res: SonioxResponse, emit: SonioxEmit, finalBuf: { value: string }): void {
  if (res.error_code !== undefined) {
    emit.streamError(`Soniox error ${res.error_code}: ${res.error_message ?? "unknown"}`);
    return;
  }
  // ARRAY-checked, not truthy-checked: `tokens.length === 0` is false for a
  // truthy non-array (`undefined === 0`), so `"tokens": 5` — a field with the
  // wrong type, which is what a service shipping a new shape emits — used to
  // reach the `for … of` below and throw "not iterable" straight out of
  // `ws.on("message")`, i.e. an uncaughtException on a multi-tenant host.
  // Dropping it keeps the rest of the frame usable: an `error_code` alongside
  // it is still surfaced above.
  if (!Array.isArray(res.tokens) || res.tokens.length === 0) return;
  const nonFinal = consumeTokens(res.tokens, (text) => {
    finalBuf.value += text;
  });
  // Batch contiguous finals into one `final` event by flushing only when
  // a new non-final preview starts (or the session finishes).
  if (finalBuf.value.length > 0 && (nonFinal.length > 0 || res.finished)) {
    emit.emitFinal(finalBuf.value);
    finalBuf.value = "";
  } else if (finalBuf.value.length > 0) {
    // Soniox runs without endpoint detection, so an utterance whose last
    // frames are all-final (user stops, no more partials) would otherwise sit
    // buffered until the *next* utterance's first partial flushes it — the
    // pipeline never gets a `final` and the turn never commits. Arm a short
    // quiet timer to flush it on its own.
    emit.armFlush();
  }
  if (nonFinal.length > 0) {
    emit.emitPartial(nonFinal);
  }
}

export function openSoniox(opts: SonioxSttOptions = {}): SttOpener {
  return {
    name: "soniox",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(openOpts.apiKey, SONIOX_API_KEY_ENV, "Soniox STT", (msg) =>
        createSttError("stt_auth_failed", msg),
      );

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      const finalBuf = { value: "" };

      // Bounded and abort-wired: an upgrade that black-holes must not leave
      // `open()` pending with a socket nobody owns — see `openGuardedWs`. The
      // config frame goes out inside the same guarded window, since a failed
      // first send is a failed open.
      const ws = await openGuardedWs({
        create: () => new WebSocket(SONIOX_WS_URL, PROVIDER_WS_OPTIONS),
        label: "Soniox STT",
        makeConnectError: (msg) => createSttError("stt_connect_failed", msg),
        signal: openOpts.signal,
        onOpen: (socket) =>
          socket.send(JSON.stringify(buildConfigFrame(apiKey, opts, openOpts.sampleRate))),
      });

      // Every emit goes through the shell: it owns the closed latch and the
      // throw containment a socket 'message' handler needs (a listener that
      // throws would otherwise escape as an uncaughtException).
      const flushTimer = createRestartableTimer(() => {
        if (finalBuf.value.length > 0) {
          shell.emit("final", finalBuf.value);
          finalBuf.value = "";
        }
      });

      const emit: SonioxEmit = {
        emitFinal: (text) => {
          flushTimer.clear();
          shell.emit("final", text);
        },
        emitPartial: (text) => shell.emit("partial", text),
        streamError: (message) => shell.streamError(message),
        armFlush: () => flushTimer.arm(SONIOX_FINAL_FLUSH_MS),
      };

      const shell = createSttSessionShell({
        emitter,
        teardown: () => {
          flushTimer.clear();
          // Flush any batched finals so the last utterance isn't dropped. This
          // runs after the shell marked the session closed, so `shell.emit`
          // (gated on `closed`) would swallow it — emit directly, still
          // containing a listener throw so it can't escape teardown.
          if (finalBuf.value.length > 0) {
            try {
              emitter.emit("final", finalBuf.value);
            } catch {
              // A listener threw during teardown; nothing further to do.
            }
            finalBuf.value = "";
          }
          // Detach and close, leaving a zero-listener error guard so a late
          // error during the close handshake can't crash the process.
          dropSocket(ws);
        },
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        if (shell.isClosed()) return;
        const res = parseFrame(raw);
        if (res) handleResponse(res, emit, finalBuf);
      });

      ws.on("error", (err: Error) => shell.onSocketError(err));
      ws.on("close", (code: number) => shell.onSocketClose(code));

      closeOnAbort(openOpts.signal, shell.close);

      // Drop audio frames while the provider link is stalled — mic audio is
      // real-time paced and loss-tolerant; see _audio-gate.ts.
      const audioGate = createAudioSendGate({
        bufferedAmount: () => ws.bufferedAmount,
        label: "Soniox STT",
      });

      return {
        sendAudio(pcm: Int16Array) {
          if (shell.isClosed() || ws.readyState !== WebSocket.OPEN) return;
          if (audioGate.shouldDrop()) return;
          ws.send(pcm16ToBytes(pcm), { binary: true });
        },
        on: shell.on,
        close: shell.close,
      };
    },
  };
}
