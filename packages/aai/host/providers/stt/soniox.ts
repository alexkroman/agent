// Copyright 2026 the AAI authors. MIT license.

import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import {
  resolveSonioxSettings,
  SONIOX_API_KEY_ENV,
  type SonioxOptions,
} from "../../../sdk/providers/stt/soniox.ts";
import {
  makeSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../../../sdk/providers.ts";
import { safeJsonParse } from "../../../sdk/utils.ts";
import { createAudioSendGate } from "../../_audio-gate.ts";
import { pcm16ToBytes } from "../../_pcm.ts";
import { createRestartableTimer } from "../../_timer.ts";
import { PROVIDER_WS_OPTIONS } from "../../_ws.ts";
import {
  closeOnAbort,
  connectOrThrow,
  createGuardedWs,
  createSessionShell,
  dropSocket,
  requireApiKey,
  waitForOpen,
} from "../_utils.ts";

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
  opts: SonioxOptions,
  sampleRate: number,
): Record<string, unknown> {
  const settings = resolveSonioxSettings(opts);
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

function parseFrame(raw: WebSocket.RawData): SonioxResponse | null {
  return (safeJsonParse(raw.toString()) as SonioxResponse | undefined) ?? null;
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
  if (!res.tokens || res.tokens.length === 0) return;
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

export function openSoniox(opts: SonioxOptions = {}): SttOpener {
  return {
    name: "soniox",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(openOpts.apiKey, SONIOX_API_KEY_ENV, "Soniox STT", (msg) =>
        makeSttError("stt_auth_failed", msg),
      );

      const ws = createGuardedWs(
        () => new WebSocket(SONIOX_WS_URL, PROVIDER_WS_OPTIONS),
        (msg) => makeSttError("stt_connect_failed", msg),
        "Soniox STT",
      );
      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      const finalBuf = { value: "" };

      // Emit `final`/`partial` through the shell's throw containment: a
      // listener that throws must not escape a socket 'message' handler (an
      // uncaughtException), and nothing may be emitted once the session closed.
      const safeEmitFinal = (text: string): void =>
        shell.safeEmit(() => emitter.emit("final", text));
      const safeEmitPartial = (text: string): void =>
        shell.safeEmit(() => emitter.emit("partial", text));

      const flushTimer = createRestartableTimer(() => {
        if (finalBuf.value.length > 0) {
          safeEmitFinal(finalBuf.value);
          finalBuf.value = "";
        }
      });

      const emit: SonioxEmit = {
        emitFinal: (text) => {
          flushTimer.clear();
          safeEmitFinal(text);
        },
        emitPartial: safeEmitPartial,
        streamError: (message) => shell.streamError(message),
        armFlush: () => flushTimer.arm(SONIOX_FINAL_FLUSH_MS),
      };

      const shell = createSessionShell({
        makeStreamError: (msg) => makeSttError("stt_stream_error", msg),
        emitError: (err) => emitter.emit("error", err),
        // A provider-initiated close ends the transcript stream — see the option doc.
        cleanCloseIsFatal: true,
        teardown: () => {
          flushTimer.clear();
          // Flush any batched finals so the last utterance isn't dropped. This
          // runs after the shell marked the session closed, so `safeEmit`
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

      try {
        await connectOrThrow(
          "Soniox STT",
          (msg) => makeSttError("stt_connect_failed", msg),
          () => waitForOpen(ws),
        );

        ws.send(JSON.stringify(buildConfigFrame(apiKey, opts, openOpts.sampleRate)));
      } catch (err) {
        // Failed connect / config send: close the socket before rethrowing so
        // it can't linger half-open (late errors land in the guard listener).
        dropSocket(ws);
        throw err;
      }

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
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close: shell.close,
      };
    },
  };
}
