// Copyright 2026 the AAI authors. MIT license.
/**
 * Rime TTS opener (host-only).
 *
 * Connects to Rime's `ws2` JSON WebSocket endpoint with one long-lived
 * connection per session. Client → server: `{ text }` appends to the
 * synthesis buffer, `{ operation: "clear" }` drops it (barge-in). We never
 * send `eos` since it tears down the WS — `flush()` instead sends a
 * trailing `"."` to force synthesis of any text buffered behind missing
 * terminal punctuation while keeping the connection reusable.
 *
 * Server → client: `{ type: "chunk", data: <base64 PCM16 LE> }` carries
 * audio; `timestamps` is ignored; `error` surfaces as `tts_stream_error`.
 * The `audioFormat=pcm` query param at the negotiated `sampleRate` returns
 * raw PCM16 LE that we view as a zero-copy `Int16Array`.
 */

import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import {
  RIME_DEFAULT_MODEL,
  RIME_DEFAULT_VOICE,
  type RimeOptions,
} from "../../../sdk/providers/tts/rime.ts";
import {
  makeTtsError,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
} from "../../../sdk/providers.ts";

export interface RimeSession extends TtsSession {
  /** @internal Test-only: exposes the underlying raw WebSocket. */
  readonly _ws: WebSocket;
}

const RIME_PCM16_RATES = [
  8000, 16_000, 22_050, 24_000, 44_100, 48_000,
] as const satisfies readonly number[];

const RIME_PCM16_RATES_STR = RIME_PCM16_RATES.join(", ");

function assertSupportedSampleRate(rate: number): number {
  if ((RIME_PCM16_RATES as readonly number[]).includes(rate)) return rate;
  throw makeTtsError(
    "tts_connect_failed",
    `Rime TTS: unsupported sample rate ${rate}. Supported: ${RIME_PCM16_RATES_STR}.`,
  );
}

function base64ToPcm(data: string): Int16Array {
  const bytes = Buffer.from(data, "base64");
  // Defensive: drop a trailing odd byte rather than throw on misalignment.
  const evenLen = bytes.byteLength - (bytes.byteLength % 2);
  if (evenLen === 0) return new Int16Array(0);
  return new Int16Array(bytes.buffer, bytes.byteOffset, evenLen / 2);
}

interface RimeMessage {
  type: string;
  data?: string;
  contextId?: string | null;
  message?: string;
}

const QUIESCENCE_MS = 500;

// Greetings and short replies emit `flush()` immediately after `sendText()`,
// so audio TTFB easily exceeds QUIESCENCE_MS. Wait longer for the FIRST
// chunk; subsequent chunks revert to the shorter quiescence window.
const FIRST_AUDIO_TIMEOUT_MS = 5000;

// Pre-serialized static payloads — avoid allocating a new object + stringify on every call.
const FLUSH_MSG = '{"text":"."}';
const CLEAR_MSG = '{"operation":"clear"}';

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.removeListener("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      ws.removeListener("open", onOpen);
      reject(
        makeTtsError(
          "tts_connect_failed",
          `Rime TTS: connect failed: ${err?.message ?? String(err)}`,
        ),
      );
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

// Extracted to a top-level function to keep `open()` under the cognitive
// complexity limit; session state is threaded through via the ref callbacks.
function handleRimeMessage(
  raw: WebSocket.Data,
  emitter: Emitter<TtsEvents>,
  armQuiescence: () => void,
  hasActiveTimer: boolean,
): void {
  let msg: RimeMessage;
  try {
    // Node's JSON.parse accepts Buffer directly — no intermediate toString() copy needed.
    msg = JSON.parse(raw as string) as RimeMessage;
  } catch {
    return;
  }

  if (msg.type === "chunk" && typeof msg.data === "string") {
    const pcm = base64ToPcm(msg.data);
    if (pcm.length > 0) {
      emitter.emit("audio", pcm);
      // Each chunk resets the quiescence window so `done` fires only after
      // audio stops — applies to both the first-audio and post-chunk timers.
      if (hasActiveTimer) armQuiescence();
    }
    return;
  }
  if (msg.type === "error") {
    emitter.emit(
      "error",
      makeTtsError("tts_stream_error", `Rime TTS: ${msg.message ?? "unknown error"}`),
    );
  }
}

export function openRime(opts: RimeOptions): TtsOpener {
  return {
    name: "rime",
    async open(openOpts: TtsOpenOptions): Promise<TtsSession> {
      const apiKey = openOpts.apiKey || process.env.RIME_API_KEY;
      if (!apiKey) {
        throw makeTtsError(
          "tts_auth_failed",
          "Rime TTS: missing API key. Set RIME_API_KEY in the agent env.",
        );
      }

      const sampleRate = assertSupportedSampleRate(openOpts.sampleRate);
      const model = opts.model ?? RIME_DEFAULT_MODEL;
      const lang = opts.language ?? "eng";
      const voice = opts.voice ?? RIME_DEFAULT_VOICE;

      const url = `wss://users-ws.rime.ai/ws2?speaker=${encodeURIComponent(voice)}&modelId=${encodeURIComponent(model)}&audioFormat=pcm&samplingRate=${sampleRate}&lang=${encodeURIComponent(lang)}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      } catch (cause) {
        throw makeTtsError(
          "tts_connect_failed",
          `Rime TTS: failed to create WebSocket: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      await waitForOpen(ws);

      const emitter: Emitter<TtsEvents> = createNanoEvents<TtsEvents>();
      let closed = false;
      let doneEmitted = false;
      let quiescenceTimer: ReturnType<typeof setTimeout> | null = null;

      const clearQuiescence = () => {
        if (quiescenceTimer !== null) {
          clearTimeout(quiescenceTimer);
          quiescenceTimer = null;
        }
      };

      const emitDoneOnce = () => {
        clearQuiescence();
        if (doneEmitted || closed) return;
        doneEmitted = true;
        emitter.emit("done");
      };

      const armTimer = (delayMs: number) => {
        clearQuiescence();
        quiescenceTimer = setTimeout(emitDoneOnce, delayMs);
      };

      const canSend = () => !closed && ws.readyState === WebSocket.OPEN;

      ws.on("message", (raw: WebSocket.Data) => {
        if (closed) return;
        handleRimeMessage(raw, emitter, () => armTimer(QUIESCENCE_MS), quiescenceTimer !== null);
      });

      ws.on("error", (err: Error) => {
        if (closed) return;
        emitter.emit(
          "error",
          makeTtsError("tts_stream_error", `Rime TTS stream error: ${err?.message ?? String(err)}`),
        );
      });

      ws.on("close", () => {
        if (closed) return;
        // Unexpected server-side close — surface `done` so the pipeline
        // doesn't hang waiting for an utterance that will never complete.
        emitDoneOnce();
      });

      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        clearQuiescence();
        try {
          ws.close();
        } catch {
          // Caller has already decided to tear down.
        }
      };

      if (openOpts.signal.aborted) {
        void close();
      } else {
        openOpts.signal.addEventListener("abort", () => void close(), { once: true });
      }

      const session: RimeSession = {
        sendText(text: string) {
          if (!canSend() || text.length === 0) return;
          doneEmitted = false;
          ws.send(JSON.stringify({ text }));
        },

        flush() {
          if (!canSend()) return;
          // Force synthesis of any text buffered behind missing terminal
          // punctuation: a trailing `"."` keeps the WS reusable, whereas
          // the JSON `eos` operation would close it and require a
          // reconnect every turn.
          ws.send(FLUSH_MSG);
          armTimer(FIRST_AUDIO_TIMEOUT_MS);
        },

        cancel() {
          if (closed) return;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(CLEAR_MSG);
          }
          // Emit `done` synchronously — the orchestrator's state machine
          // advances on `done`, and barge-in must not be microtask-deferred.
          emitDoneOnce();
        },

        on(event, fn) {
          return emitter.on(event, fn);
        },

        close,

        _ws: ws,
      };

      return session;
    },
  };
}
