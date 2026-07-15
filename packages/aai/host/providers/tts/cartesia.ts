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
import type { TTSWS, TTSWSContext } from "@cartesia/cartesia-js/resources/tts/ws";
import { createNanoEvents, type Emitter } from "nanoevents";
import {
  CARTESIA_DEFAULT_VOICE,
  type CartesiaOptions,
} from "../../../sdk/providers/tts/cartesia.ts";
import {
  makeTtsError,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
} from "../../../sdk/providers.ts";
import { errorMessage } from "../../../sdk/utils.ts";
import { assertPcm16Rate, closeOnAbort, type Pcm16Rate, requireApiKey } from "../_utils.ts";

/** Internal: TtsSession with a test-only handle to the raw SDK socket. */
export interface CartesiaSession extends TtsSession {
  /** @internal Test-only: exposes the underlying SDK WebSocket wrapper. */
  readonly _ws: TTSWS;
  /** @internal Test-only: id of the currently-active context. */
  readonly _currentContextId: () => string;
}

/** Build a {@link TtsOpener} from resolved Cartesia descriptor options. */
export function openCartesia(opts: CartesiaOptions): TtsOpener {
  return {
    name: "cartesia",
    async open(openOpts: TtsOpenOptions): Promise<TtsSession> {
      const apiKey = requireApiKey(openOpts.apiKey, "CARTESIA_API_KEY", "Cartesia TTS", (msg) =>
        makeTtsError("tts_auth_failed", msg),
      );

      const sampleRate: Pcm16Rate = assertPcm16Rate(openOpts.sampleRate, "Cartesia TTS", (msg) =>
        makeTtsError("tts_connect_failed", msg),
      );
      const model = opts.model ?? "sonic-2";
      const language = opts.language ?? "en";
      const voice = opts.voice ?? CARTESIA_DEFAULT_VOICE;

      const client = new Cartesia({ apiKey });
      let ws: TTSWS;
      try {
        ws = await client.tts.websocket();
      } catch (cause) {
        throw makeTtsError(
          "tts_connect_failed",
          `Cartesia TTS: connect failed: ${errorMessage(cause)}`,
        );
      }

      const emitter: Emitter<TtsEvents> = createNanoEvents<TtsEvents>();
      let closed = false;

      const audioConfig = {
        model_id: model,
        voice: { mode: "id" as const, id: voice },
        output_format: {
          container: "raw" as const,
          encoding: "pcm_s16le" as const,
          sample_rate: sampleRate,
        },
      };
      const baseRequest = { ...audioConfig, language };

      const mintContext = (): TTSWSContext =>
        ws.context({ ...audioConfig, contextId: randomUUID() });

      let context = mintContext();
      let doneEmitted = false;
      // Defer minting after flush/cancel until next sendText so late audio
      // chunks + Cartesia's real `done` (tagged with the flushed context's id)
      // still pass the filter. Rotating eagerly would drop in-flight audio.
      let rotatePending = false;
      const rotateIfPending = () => {
        if (!rotatePending) return;
        context = mintContext();
        doneEmitted = false;
        rotatePending = false;
      };
      const emitDoneOnce = () => {
        if (doneEmitted || closed) return;
        doneEmitted = true;
        emitter.emit("done");
      };

      // TTSWS fires events globally across all contexts on the shared
      // socket; filter by the currently-active context_id.
      ws.on("chunk", (event) => {
        if (closed || event.context_id !== context.contextId) return;
        const buf = event.audio;
        if (!buf || buf.byteLength === 0) return;
        // Defensive: trim odd byte counts so `new Int16Array` never throws
        // on a misaligned length.
        const evenBytes = buf.byteLength - (buf.byteLength % 2);
        if (evenBytes === 0) return;
        const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + evenBytes));
        emitter.emit("audio", pcm);
      });

      ws.on("done", (event) => {
        if (closed || event.context_id !== context.contextId) return;
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
          // Caller has already decided to tear down.
        }
      };

      closeOnAbort(openOpts.signal, close);

      const ignoreRejection = (_err: unknown): void => {
        /* no-op */
      };

      const session: CartesiaSession = {
        sendText(text: string) {
          if (closed || text.length === 0) return;
          // First sendText after flush/cancel starts a fresh context so we
          // don't append to one that's already been finalized.
          rotateIfPending();
          void context
            .send({ ...baseRequest, transcript: text, continue: true })
            .catch(ignoreRejection);
        },
        flush() {
          if (closed || rotatePending) return;
          // Empty transcript + `continue: false` is the canonical end-of-turn
          // signal. Cartesia finishes synthesizing what's queued and emits
          // `done` tagged with the same context_id; rotation is deferred so
          // in-flight audio chunks and the real `done` still pass the filter.
          void context
            .send({ ...baseRequest, transcript: "", continue: false })
            .catch(ignoreRejection);
          rotatePending = true;
        },
        cancel() {
          if (closed) return;
          // Skip the wire cancel if the context is already final on
          // Cartesia's side: cancelling a retired context returns a 400
          // ("context ID does not exist") which surfaces as a fatal
          // tts_stream_error for a benign race.
          if (!doneEmitted) {
            void context.cancel().catch(ignoreRejection);
          }
          // Emit synchronously: barge-in advances the orchestrator on `done`;
          // delaying would audibly stall subsequent turns. Cartesia stops
          // producing audio after cancel, so dropping late chunks is fine.
          emitDoneOnce();
          rotatePending = true;
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
