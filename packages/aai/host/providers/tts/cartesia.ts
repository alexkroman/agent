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
import type { TTSWSContext } from "@cartesia/cartesia-js/resources/tts/ws";
import { TTSWS } from "@cartesia/cartesia-js/resources/tts/ws";
import { createNanoEvents, type Emitter } from "nanoevents";
import {
  CARTESIA_API_KEY_ENV,
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
import { bytesToPcm16 } from "../../_pcm.ts";
import {
  assertPcm16Rate,
  closeOnAbort,
  connectOrThrow,
  createSessionShell,
  type Pcm16Rate,
  requireApiKey,
} from "../_utils.ts";

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
      const apiKey = requireApiKey(openOpts.apiKey, CARTESIA_API_KEY_ENV, "Cartesia TTS", (msg) =>
        makeTtsError("tts_auth_failed", msg),
      );

      const sampleRate: Pcm16Rate = assertPcm16Rate(openOpts.sampleRate, "Cartesia TTS", (msg) =>
        makeTtsError("tts_connect_failed", msg),
      );
      const model = opts.model ?? "sonic-2";
      const language = opts.language ?? "en";
      const voice = opts.voice ?? CARTESIA_DEFAULT_VOICE;

      const client = new Cartesia({ apiKey });

      // Construct the socket directly rather than via `client.tts.websocket()`,
      // which only hands back the instance *after* connect resolves. We need the
      // reference *before* connecting so we can bind an `error` listener up
      // front: cartesia-js's `TTSEmitter._onError` does a bare `Promise.reject`
      // — a fatal unhandled rejection that can crash the whole host process —
      // whenever the socket errors with no `error` listener bound. That is
      // exactly what happens on a connect-time failure (e.g. Cartesia out of
      // credits). Binding first routes the failure through the safe
      // `_emit("error")` path instead of taking down the process.
      const ws: TTSWS = new TTSWS(client, undefined);

      // Real behavior is installed below, once `shell`/`context` exist. During
      // the connect phase a failure is surfaced via the `connectOrThrow`
      // rejection, so this listener only needs to *exist* — its handler can
      // no-op until the session is fully wired up.
      let handleSocketError: (err: unknown) => void = () => undefined;
      ws.on("error", (err) => handleSocketError(err));

      await connectOrThrow(
        "Cartesia TTS",
        (msg) => makeTtsError("tts_connect_failed", msg),
        () => ws.connect(),
      );

      const emitter: Emitter<TtsEvents> = createNanoEvents<TtsEvents>();
      const shell = createSessionShell({
        makeStreamError: (msg) => makeTtsError("tts_stream_error", msg),
        emitError: (err) => emitter.emit("error", err),
        teardown: () => ws.close({ code: 1000, reason: "client close" }),
      });

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
        if (doneEmitted || shell.isClosed()) return;
        doneEmitted = true;
        emitter.emit("done");
      };

      // TTSWS fires events globally across all contexts on the shared
      // socket; filter by the currently-active context_id.
      ws.on("chunk", (event) => {
        if (shell.isClosed() || event.context_id !== context.contextId) return;
        const buf = event.audio;
        if (!buf || buf.byteLength === 0) return;
        // Zero-copy view when aligned; drops a trailing odd byte instead of
        // throwing on a misaligned length.
        const pcm = bytesToPcm16(buf);
        if (pcm.length === 0) return;
        emitter.emit("audio", pcm);
      });

      ws.on("done", (event) => {
        if (shell.isClosed() || event.context_id !== context.contextId) return;
        emitDoneOnce();
      });

      // Cartesia streams per-context error frames over the shared socket. A
      // benign cancel/flush/finish race yields a 400 "Invalid context ID" for a
      // context we've already cancelled or retired (its `done` may cross our
      // `cancel` on the wire). Surfacing that as a fatal `tts_stream_error`
      // would kill the session mid-run, so drop the dead-context signature (and
      // any frame tagged with a non-active context_id). Genuine socket failures
      // carry no context_id and still propagate.
      const isBenignContextError = (err: unknown): boolean => {
        const raw = errorMessage(err);
        if (/invalid context id|context id does not exist|already been cancelled/i.test(raw)) {
          return true;
        }
        try {
          const parsed = JSON.parse(raw) as { context_id?: unknown };
          return typeof parsed.context_id === "string" && parsed.context_id !== context.contextId;
        } catch {
          return false;
        }
      };

      handleSocketError = (err) => {
        if (isBenignContextError(err)) return;
        shell.onSocketError(err);
      };

      closeOnAbort(openOpts.signal, shell.close);

      const ignoreRejection = (_err: unknown): void => {
        /* no-op */
      };

      const session: CartesiaSession = {
        sendText(text: string) {
          if (shell.isClosed() || text.length === 0) return;
          // First sendText after flush/cancel starts a fresh context so we
          // don't append to one that's already been finalized.
          rotateIfPending();
          void context
            .send({ ...baseRequest, transcript: text, continue: true })
            .catch(ignoreRejection);
        },
        flush() {
          if (shell.isClosed() || rotatePending) return;
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
          if (shell.isClosed()) return;
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
        close: shell.close,
        _ws: ws,
        _currentContextId: () => context.contextId,
      };
      return session;
    },
  };
}
