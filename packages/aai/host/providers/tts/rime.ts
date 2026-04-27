// Copyright 2026 the AAI authors. MIT license.
/**
 * Rime TTS opener (host-only).
 *
 * The user-facing descriptor factory (`rime(...)`) lives in
 * `sdk/providers/tts/rime.ts`. This module is the host-side
 * counterpart: it takes the descriptor options + an API key and
 * returns a {@link TtsOpener} that the pipeline session drives.
 *
 * **Protocol.** Connects to Rime's `ws2` JSON WebSocket endpoint
 * (`wss://users-ws.rime.ai/ws2`). Client-to-server messages are JSON:
 *   - `{ "text": "..." }` — append text to the synthesis buffer
 *   - `{ "operation": "clear" }` — drop buffered text (barge-in)
 *   - `{ "operation": "eos" }` — drain buffer, close connection (NOT used
 *     during a session: it would tear down the WS, forcing reconnect per
 *     turn). We force end-of-turn synthesis with a trailing `"."` instead.
 * The server responds with JSON frames:
 *   - `{ type: "chunk", data: <base64 PCM16 LE>, contextId: string | null }`
 *   - `{ type: "timestamps", ... }` (ignored)
 *   - `{ type: "error", message: string }` (surfaced as `tts_stream_error`)
 *
 * **Single long-lived connection per session.** Rime buffers text until it
 * sees terminal punctuation (`.`, `?`, `!`), so we use one WebSocket per
 * `open()` call and reuse it across turns. `clear` resets the buffer
 * between cancellations.
 *
 * **Done detection.** After `flush()` sends a trailing `"."` to force the
 * server to synthesize any half-buffered text, we arm a quiescence timer
 * that fires 500 ms after the last received audio chunk. When it fires,
 * `done` is emitted.
 *
 * **Audio format.** The URL requests `audioFormat=pcm` at the negotiated
 * `sampleRate`, which returns raw PCM16 little-endian. We decode the base64
 * payload and construct a zero-copy `Int16Array` view over the decoded bytes.
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

/** Internal: TtsSession with a test-only handle to the raw WebSocket. */
export interface RimeSession extends TtsSession {
  /** @internal Test-only: exposes the underlying raw WebSocket. */
  readonly _ws: WebSocket;
}

/** PCM16 sample rates accepted by the Rime `ws2` endpoint. */
const RIME_PCM16_RATES = [
  8000, 16_000, 22_050, 24_000, 44_100, 48_000,
] as const satisfies readonly number[];

function assertSupportedSampleRate(rate: number): number {
  if ((RIME_PCM16_RATES as readonly number[]).includes(rate)) return rate;
  throw makeTtsError(
    "tts_connect_failed",
    `Rime TTS: unsupported sample rate ${rate}. Supported: ${RIME_PCM16_RATES.join(", ")}.`,
  );
}

/**
 * Decode a base64 string from Rime into a zero-copy `Int16Array`.
 *
 * Rime's `ws2` endpoint returns base64-encoded PCM16 LE in each chunk.
 * `Buffer.from(base64, "base64")` gives us a Node.js Buffer (which is a
 * Uint8Array subclass) with `byteOffset === 0`. PCM16 bytes always come in
 * pairs so the length is guaranteed to be even.
 */
function base64ToPcm(data: string): Int16Array {
  const bytes = Buffer.from(data, "base64");
  // Defensive: drop a trailing odd byte rather than throwing on misalignment.
  const evenLen = bytes.byteLength - (bytes.byteLength % 2);
  if (evenLen === 0) return new Int16Array(0);
  return new Int16Array(bytes.buffer, bytes.byteOffset, evenLen / 2);
}

/**
 * Shape of JSON messages received from Rime's `ws2` endpoint.
 *
 * Only `chunk` messages carry audio; `timestamps` messages are informational
 * and can be ignored for the current use case.
 */
interface RimeMessage {
  type: "chunk" | "timestamps" | "error" | string;
  /** Base64-encoded PCM16 LE audio. Present on `type === "chunk"`. */
  data?: string;
  /** Context discriminator for the in-flight utterance. May be null. */
  contextId?: string | null;
  /** Error description. Present on `type === "error"`. */
  message?: string;
}

/** Quiescence timeout in ms — how long to wait after the last audio chunk before emitting `done`. */
const QUIESCENCE_MS = 500;

/**
 * After `flush()`, how long to wait for the FIRST audio chunk before
 * giving up and emitting `done`. Greeting and short replies hit this
 * path: `flush()` runs immediately after `sendText()`, so audio TTFB
 * exceeds the 500 ms quiescence window. Once the first chunk arrives,
 * we transition to the shorter quiescence timeout.
 */
const FIRST_AUDIO_TIMEOUT_MS = 5000;

/** Wait for the WebSocket `open` event; reject on first `error`. */
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

/**
 * Handle one incoming WebSocket message frame.
 *
 * Extracted into a top-level function to keep `open()` under the cognitive
 * complexity limit while retaining full access to the session state via refs.
 */
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
    // Unparseable frame — ignore.
    return;
  }

  if (msg.type === "chunk" && typeof msg.data === "string") {
    const pcm = base64ToPcm(msg.data);
    if (pcm.length > 0) {
      emitter.emit("audio", pcm);
      // While we're waiting on a flush (long timer for first audio, or
      // short timer between chunks), each chunk resets to the short
      // quiescence window — so `done` fires only after audio stops.
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
  // Ignore `type === "timestamps"` and unknown message types.
}

/** Build a {@link TtsOpener} from resolved Rime descriptor options. */
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
      const model = opts.model ?? "mistv2";
      const lang = opts.language ?? "eng";
      const voice = opts.voice ?? RIME_DEFAULT_VOICE;

      // Construct the ws2 URL with query parameters.
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
      /**
       * After `flush()`, we arm a timer that fires `done`. Initial timeout is
       * `FIRST_AUDIO_TIMEOUT_MS` to give Rime headroom on TTFB; the first
       * chunk swaps it for a shorter `QUIESCENCE_MS` window that resets on
       * each subsequent chunk. `cancel()` emits `done` synchronously.
       */
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
          // Swallow: caller has already decided to tear down.
        }
      };

      if (openOpts.signal.aborted) {
        void close();
      } else {
        openOpts.signal.addEventListener("abort", () => void close(), { once: true });
      }

      const session: RimeSession = {
        sendText(text: string) {
          if (closed || text.length === 0) return;
          if (ws.readyState !== WebSocket.OPEN) return;
          // Reset done state at the start of a new turn.
          doneEmitted = false;
          ws.send(JSON.stringify({ text }));
        },

        flush() {
          if (closed) return;
          if (ws.readyState !== WebSocket.OPEN) return;
          // Force synthesis of any text buffered behind a missing terminal
          // punctuation: append a trailing `"."`. Sending the JSON `eos`
          // operation would close the connection, requiring a reconnect on
          // every turn — `"."` keeps the WS reusable. Use the longer
          // first-audio timer until the initial chunk arrives; the chunk
          // handler swaps it for short quiescence on each subsequent chunk.
          ws.send(JSON.stringify({ text: "." }));
          armFirstAudioTimer();
        },

        cancel() {
          if (closed) return;
          // Drop Rime's server-side buffer for barge-in.
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
