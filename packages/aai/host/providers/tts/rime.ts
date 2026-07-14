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
import { RIME_DEFAULT_VOICE, type RimeOptions } from "../../../sdk/providers/tts/rime.ts";
import {
  makeTtsError,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
} from "../../../sdk/providers.ts";
import { errorMessage } from "../../../sdk/utils.ts";
import { assertPcm16Rate, closeOnAbort, requireApiKey, waitForOpen } from "../_utils.ts";

export interface RimeSession extends TtsSession {
  /** @internal Test-only: exposes the underlying raw WebSocket. */
  readonly _ws: WebSocket;
}

function base64ToPcm(data: string): Int16Array {
  const bytes = Buffer.from(data, "base64");
  // Defensive: drop a trailing odd byte rather than throw on misalignment.
  const evenLen = bytes.byteLength - (bytes.byteLength % 2);
  if (evenLen === 0) return new Int16Array(0);
  return new Int16Array(bytes.buffer, bytes.byteOffset, evenLen / 2);
}

interface RimeMessage {
  type: "chunk" | "timestamps" | "error" | string;
  data?: string;
  contextId?: string | null;
  message?: string;
}

const QUIESCENCE_MS = 500;

// Greetings and short replies emit `flush()` immediately after `sendText()`,
// so audio TTFB easily exceeds QUIESCENCE_MS. Wait longer for the FIRST
// chunk; subsequent chunks revert to the shorter quiescence window.
const FIRST_AUDIO_TIMEOUT_MS = 5000;

// Extracted to a top-level function to keep `open()` under the cognitive
// complexity limit; session state is threaded through via the ref callbacks.
function handleRimeMessage(
  raw: WebSocket.Data,
  emitter: Emitter<TtsEvents>,
  armQuiescence: () => void,
  isActiveTimer: () => boolean,
): void {
  let msg: RimeMessage;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as RimeMessage;
  } catch {
    return;
  }

  if (msg.type === "chunk" && typeof msg.data === "string") {
    const pcm = base64ToPcm(msg.data);
    if (pcm.length > 0) {
      emitter.emit("audio", pcm);
      // Each chunk resets the quiescence window so `done` fires only after
      // audio stops — applies to both the first-audio and post-chunk timers.
      if (isActiveTimer()) armQuiescence();
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
      const apiKey = requireApiKey(openOpts.apiKey, "RIME_API_KEY", "Rime TTS", (msg) =>
        makeTtsError("tts_auth_failed", msg),
      );

      const sampleRate = assertPcm16Rate(openOpts.sampleRate, "Rime TTS", (msg) =>
        makeTtsError("tts_connect_failed", msg),
      );
      const model = opts.model ?? "mistv2";
      const lang = opts.language ?? "eng";
      const voice = opts.voice ?? RIME_DEFAULT_VOICE;

      const url = `wss://users-ws.rime.ai/ws2?speaker=${encodeURIComponent(voice)}&modelId=${encodeURIComponent(model)}&audioFormat=pcm&samplingRate=${sampleRate}&lang=${encodeURIComponent(lang)}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      } catch (cause) {
        throw makeTtsError(
          "tts_connect_failed",
          `Rime TTS: failed to create WebSocket: ${errorMessage(cause)}`,
        );
      }

      try {
        await waitForOpen(ws);
      } catch (cause) {
        throw makeTtsError(
          "tts_connect_failed",
          `Rime TTS: connect failed: ${errorMessage(cause)}`,
        );
      }

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

      const armQuiescence = () => {
        clearQuiescence();
        quiescenceTimer = setTimeout(emitDoneOnce, QUIESCENCE_MS);
      };

      const armFirstAudioTimer = () => {
        clearQuiescence();
        quiescenceTimer = setTimeout(emitDoneOnce, FIRST_AUDIO_TIMEOUT_MS);
      };

      ws.on("message", (raw: WebSocket.Data) => {
        if (closed) return;
        handleRimeMessage(raw, emitter, armQuiescence, () => quiescenceTimer !== null);
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

      closeOnAbort(openOpts.signal, close);

      const session: RimeSession = {
        sendText(text: string) {
          if (closed || text.length === 0) return;
          if (ws.readyState !== WebSocket.OPEN) return;
          doneEmitted = false;
          ws.send(JSON.stringify({ text }));
        },

        flush() {
          if (closed) return;
          if (ws.readyState !== WebSocket.OPEN) return;
          // Force synthesis of any text buffered behind missing terminal
          // punctuation: a trailing `"."` keeps the WS reusable, whereas
          // the JSON `eos` operation would close it and require a
          // reconnect every turn.
          ws.send(JSON.stringify({ text: "." }));
          armFirstAudioTimer();
        },

        cancel() {
          if (closed) return;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ operation: "clear" }));
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
