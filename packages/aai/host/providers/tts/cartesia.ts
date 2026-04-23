// Copyright 2025 the AAI authors. MIT license.
/**
 * Cartesia TTS opener (host-only).
 *
 * The user-facing descriptor factory (`cartesia(...)`) lives in
 * `sdk/providers/tts/cartesia.ts`. This module is the host-side
 * counterpart: it takes the descriptor options + an API key and
 * returns a {@link TtsOpener} that the pipeline session drives.
 *
 * Wraps `@cartesia/cartesia-js`'s `TTSWS` / `TTSWSContext` and normalizes it
 * onto the {@link TtsEvents} contract consumed by the pipeline orchestrator.
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
import type { CartesiaOptions } from "../../../sdk/providers/tts/cartesia.ts";
import {
  makeTtsError,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
} from "../../../sdk/providers.ts";

/** Internal: TtsSession with a test-only handle to the raw SDK socket. */
export interface CartesiaSession extends TtsSession {
  /** @internal Test-only: exposes the underlying SDK WebSocket wrapper. */
  readonly _ws: TTSWS;
  /** @internal Test-only: id of the currently-active context. */
  readonly _currentContextId: () => string;
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
  throw makeTtsError(
    "tts_connect_failed",
    `Cartesia TTS: unsupported sample rate ${rate}. Supported: ${CARTESIA_PCM16_RATES.join(", ")}.`,
  );
}

/** Build a {@link TtsOpener} from resolved Cartesia descriptor options. */
export function openCartesia(opts: CartesiaOptions): TtsOpener {
  return {
    name: "cartesia",
    async open(openOpts: TtsOpenOptions): Promise<TtsSession> {
      const apiKey = openOpts.apiKey || process.env.CARTESIA_API_KEY;
      if (!apiKey) {
        throw makeTtsError(
          "tts_auth_failed",
          "Cartesia TTS: missing API key. Set CARTESIA_API_KEY in the agent env.",
        );
      }

      const sampleRate = assertSupportedSampleRate(openOpts.sampleRate);
      const model = opts.model ?? "sonic-2";
      const language = opts.language ?? "en";

      const client = new Cartesia({ apiKey });
      let ws: TTSWS;
      try {
        ws = await client.tts.websocket();
      } catch (cause) {
        throw makeTtsError(
          "tts_connect_failed",
          `Cartesia TTS: connect failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
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

      // TTSWS fires events globally across all contexts on the shared
      // socket; filter by the currently-active context_id.
      ws.on("chunk", (event) => {
        if (closed) return;
        if (event.context_id !== context.contextId) return;
        const buf = event.audio;
        if (!buf || buf.byteLength === 0) return;
        // Cartesia sends PCM16 LE; be defensive about odd byte counts
        // so `new Int16Array` never throws on a misaligned length.
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
        emitter.emit("error", makeTtsError("tts_stream_error", err?.message ?? String(err)));
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

      if (openOpts.signal.aborted) {
        void close();
      } else {
        openOpts.signal.addEventListener("abort", () => void close(), {
          once: true,
        });
      }

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

      const ignoreRejection = (_err: unknown): void => {
        // intentionally empty
      };

      const session: CartesiaSession = {
        sendText(text: string) {
          if (closed || text.length === 0) return;
          void context
            .send({ ...baseRequest, transcript: text, continue: true })
            .catch(ignoreRejection);
        },
        flush() {
          if (closed) return;
          // Empty transcript with `continue: false` is the canonical
          // end-of-turn signal. Cartesia replies with a `done` tagged
          // by context_id, driving `emitDoneOnce`. The microtask
          // fallback guards against a dropped server event wedging
          // the orchestrator's state machine.
          // TODO: drop the microtask fallback once we've verified
          // Cartesia always emits `done` for cleanly-flushed contexts.
          void context
            .send({ ...baseRequest, transcript: "", continue: false })
            .catch(ignoreRejection);
          queueMicrotask(emitDoneOnce);
          rotateContext();
        },
        cancel() {
          if (closed) return;
          void context.cancel().catch(ignoreRejection);
          // Emit synchronously: barge-in advances the orchestrator's
          // state machine on `done`, and delaying it would audibly
          // stall subsequent turns.
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
