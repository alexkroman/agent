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
 * (`wss://users.rime.ai/ws2`). Text chunks are sent as plain WebSocket
 * string messages. End-of-utterance is signalled with `<EOS>`; barge-in
 * with `<CLEAR>`. The server responds with JSON frames:
 *   - `{ type: "chunk", data: <base64 PCM16 LE>, contextId: string | null }`
 *   - `{ type: "timestamps", ... }` (ignored)
 *
 * **Single long-lived connection per session.** Rime supports multi-turn
 * on a single connection via the `<CLEAR>` sentinel between utterances.
 * We use one WebSocket per `open()` call (i.e. per pipeline session) and
 * reuse it across turns using `<CLEAR>` to reset between them.
 *
 * **Done detection.** After `flush()` sends `<EOS>`, we start a quiescence
 * timer that fires 500 ms after the last received audio chunk. When it fires,
 * `done` is emitted. This avoids depending on the server-side close event
 * (which would require reconnecting on each turn).
 *
 * **Audio format.** The URL requests `audioFormat=pcm` at the negotiated
 * `sampleRate`, which returns raw PCM16 little-endian. We decode the base64
 * payload and construct a zero-copy `Int16Array` view over the decoded bytes.
 */

import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import type { RimeOptions } from "../../../sdk/providers/tts/rime.ts";
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
  type: "chunk" | "timestamps" | string;
  /** Base64-encoded PCM16 LE audio. Present on `type === "chunk"`. */
  data?: string;
  /** Context discriminator for the in-flight utterance. May be null. */
  contextId?: string | null;
}

/** Quiescence timeout in ms — how long to wait after the last audio chunk before emitting `done`. */
const QUIESCENCE_MS = 500;

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
      // Reset the quiescence timer on each audio chunk so we don't
      // emit `done` while audio is still streaming.
      if (isActiveTimer()) armQuiescence();
    }
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

      // Construct the ws2 URL with query parameters.
      const url = `wss://users.rime.ai/ws2?speaker=${encodeURIComponent(opts.voice)}&modelId=${encodeURIComponent(model)}&audioFormat=pcm&samplingRate=${sampleRate}&lang=${encodeURIComponent(lang)}`;

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
       * After `flush()`, we arm a quiescence timer that fires `done` 500 ms
       * after the last audio chunk from Rime. Each incoming chunk resets it.
       * After `cancel()`, `done` is emitted synchronously and the timer is cleared.
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
          ws.send(text);
        },

        flush() {
          if (closed) return;
          if (ws.readyState !== WebSocket.OPEN) return;
          // Send end-of-utterance sentinel. Rime will finish synthesizing
          // buffered text and drain all audio chunks. We arm the quiescence
          // timer here — it fires `done` 500 ms after the last audio chunk.
          ws.send("<EOS>");
          armQuiescence();
        },

        cancel() {
          if (closed) return;
          // Send barge-in sentinel to clear Rime's server-side buffer.
          if (ws.readyState === WebSocket.OPEN) {
            ws.send("<CLEAR>");
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
