// Copyright 2025 the AAI authors. MIT license.
/**
 * Cartesia TTS adapter — streaming WebSocket with per-turn `context_id`.
 *
 * Wraps `@cartesia/cartesia-js`'s `TTSWS` / `TTSWSContext` and normalizes it
 * onto the {@link TtsProvider} / {@link TtsEvents} contract consumed by the
 * pipeline orchestrator.
 *
 * **Per-turn context lifecycle.** Each `sendText(...)` within the same turn
 * appends to the same Cartesia context. On `flush()` or `cancel()`, a new
 * context is minted for the next turn — so concurrent `cancel({ contextId })`
 * only targets the in-flight turn, never the one that follows.
 *
 * **Audio format.** The adapter requests `raw` / `pcm_s16le` at the
 * negotiated `sampleRate` so it can forward chunks as `Int16Array` with no
 * conversion.
 */

import { randomUUID } from "node:crypto";
import { Cartesia } from "@cartesia/cartesia-js";
import type { TTSWS, TTSWSContext } from "@cartesia/cartesia-js/resources/tts";
import { createNanoEvents, type Emitter } from "nanoevents";
import type {
  TtsError,
  TtsEvents,
  TtsOpenOptions,
  TtsProvider,
  TtsSession,
} from "../../../sdk/providers.ts";

export interface CartesiaOptions {
  /** Cartesia voice ID. Required. */
  voice: string;
  /** Model ID. Defaults to `"sonic-2"`. */
  model?: string;
  /**
   * Cartesia API key. Falls back to `TtsOpenOptions.apiKey`, then
   * `process.env.CARTESIA_API_KEY`.
   */
  apiKey?: string;
  /** Spoken language hint. Defaults to `"en"`. */
  language?: string;
}

/** Internal: TtsSession with a test-only handle to the raw SDK socket. */
export interface CartesiaSession extends TtsSession {
  /** @internal Test-only: exposes the underlying SDK WebSocket wrapper. */
  readonly _ws: TTSWS;
  /** @internal Test-only: id of the currently-active context. */
  readonly _currentContextId: () => string;
}

function makeError(message: string): TtsError {
  const err = new Error(message) as TtsError & { code: TtsError["code"] };
  (err as { code: TtsError["code"] }).code = "tts_stream_error";
  return err;
}

/** PCM16 sample rates supported by Cartesia's `raw` output format. */
const CARTESIA_PCM16_RATES = [
  8000, 16_000, 22_050, 24_000, 44_100, 48_000,
] as const satisfies readonly number[];
type CartesiaSampleRate = (typeof CARTESIA_PCM16_RATES)[number];

function assertSupportedSampleRate(rate: number): CartesiaSampleRate {
  if ((CARTESIA_PCM16_RATES as readonly number[]).includes(rate)) {
    return rate as CartesiaSampleRate;
  }
  const err = new Error(
    `Cartesia TTS adapter: unsupported sample rate ${rate}. Supported: ${CARTESIA_PCM16_RATES.join(", ")}.`,
  ) as TtsError & { code: TtsError["code"] };
  (err as { code: TtsError["code"] }).code = "tts_connect_failed";
  throw err;
}

export function cartesia(opts: CartesiaOptions): TtsProvider {
  return {
    name: "cartesia",
    async open(openOpts: TtsOpenOptions): Promise<TtsSession> {
      const apiKey = opts.apiKey ?? openOpts.apiKey ?? process.env.CARTESIA_API_KEY;
      if (!apiKey) {
        const err = new Error(
          "Cartesia TTS adapter: missing API key. Provide via the factory option, TtsOpenOptions, or the CARTESIA_API_KEY environment variable.",
        ) as TtsError & { code: TtsError["code"] };
        (err as { code: TtsError["code"] }).code = "tts_auth_failed";
        throw err;
      }

      const sampleRate = assertSupportedSampleRate(openOpts.sampleRate);
      const model = opts.model ?? "sonic-2";
      const language = opts.language ?? "en";

      const client = new Cartesia({ apiKey });
      let ws: TTSWS;
      try {
        ws = await client.tts.websocket();
      } catch (cause) {
        const err = new Error(
          `Cartesia TTS: connect failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ) as TtsError & { code: TtsError["code"] };
        (err as { code: TtsError["code"] }).code = "tts_connect_failed";
        throw err;
      }

      const emitter: Emitter<TtsEvents> = createNanoEvents<TtsEvents>();
      let closed = false;

      /** Mint a fresh context bound to the shared TTSWS connection. */
      const mintContext = (): TTSWSContext =>
        ws.context({
          model_id: model,
          voice: { mode: "id", id: opts.voice },
          output_format: {
            container: "raw",
            encoding: "pcm_s16le",
            sample_rate: sampleRate,
          },
          contextId: randomUUID(),
        });

      let context = mintContext();
      /**
       * `doneEmitted` guards against emitting `done` more than once per turn.
       * Reset whenever a fresh context is minted (i.e. at turn boundaries).
       */
      let doneEmitted = false;
      const rotateContext = () => {
        context = mintContext();
        doneEmitted = false;
      };
      const emitDoneOnce = () => {
        if (doneEmitted || closed) return;
        doneEmitted = true;
        emitter.emit("done");
      };

      // Route SDK events onto the adapter's event surface, filtering by the
      // currently-active `context_id`. The TTSWS EventEmitter fires globally
      // across all contexts on the socket; we only care about the active one.
      ws.on("chunk", (event) => {
        if (closed) return;
        if (event.context_id !== context.contextId) return;
        // SDK decodes base64 → Buffer on receipt (`event.audio`). Forward as
        // Int16Array over the same byte window.
        const buf = event.audio;
        if (!buf || buf.byteLength === 0) return;
        // Cartesia sends PCM16 little-endian with even byte counts. Be defensive.
        const evenBytes = buf.byteLength - (buf.byteLength % 2);
        if (evenBytes === 0) return;
        const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + evenBytes));
        emitter.emit("audio", pcm);
      });

      ws.on("done", (event) => {
        if (closed) return;
        if (event.context_id !== context.contextId) return;
        emitDoneOnce();
      });

      ws.on("error", (err) => {
        if (closed) return;
        emitter.emit("error", makeError(err?.message ?? String(err)));
      });

      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
          ws.close({ code: 1000, reason: "client close" });
        } catch {
          // Swallow: caller has already decided to tear down.
        }
      };

      // Session-level abort → close the SDK socket.
      if (openOpts.signal.aborted) {
        void close();
      } else {
        openOpts.signal.addEventListener("abort", () => void close(), {
          once: true,
        });
      }

      /** Static part of each generation request; only `transcript` and
       * `continue` vary per send. Pinned here so `language` threads through. */
      const baseRequest = {
        model_id: model,
        voice: { mode: "id" as const, id: opts.voice },
        output_format: {
          container: "raw" as const,
          encoding: "pcm_s16le" as const,
          sample_rate: sampleRate,
        },
        language,
      };

      /**
       * Swallow rejections from async SDK calls — the global `error`
       * listener on `ws` emits a normalized {@link TtsError}, so there's
       * nothing useful for the caller to do with per-send failures.
       */
      const ignoreRejection = (_err: unknown): void => {
        // intentionally empty
      };

      const session: CartesiaSession = {
        sendText(text: string) {
          if (closed || text.length === 0) return;
          // Send a delta with `continue: true`, sharing the same
          // context_id across all deltas of this turn.
          void context
            .send({ ...baseRequest, transcript: text, continue: true })
            .catch(ignoreRejection);
        },
        flush() {
          if (closed) return;
          // Send an empty transcript with `continue: false` — the canonical
          // end-of-turn signal. The server replies with a `done` event
          // tagged with this context's id, which drives `emitDoneOnce`. We
          // also microtask-emit `done` as a fallback so the orchestrator's
          // state machine can't wedge if the server event is dropped.
          // TODO: drop the microtask fallback once we've verified Cartesia
          // always emits a `done` for cleanly-flushed contexts. See
          // 2026-04-22-pluggable-providers-design.md → "Note on flush() timing".
          void context
            .send({ ...baseRequest, transcript: "", continue: false })
            .catch(ignoreRejection);
          queueMicrotask(emitDoneOnce);
          rotateContext();
        },
        cancel() {
          if (closed) return;
          // `cancel()` calls ws.cancelContext(contextId) under the hood.
          void context.cancel().catch(ignoreRejection);
          // Emit `done` synchronously — the orchestrator's state machine
          // advances on `done`, and barge-in must not be delayed.
          emitDoneOnce();
          rotateContext();
        },
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close,
        _ws: ws,
        _currentContextId: () => context.contextId,
      };

      return session;
    },
  };
}
