// Copyright 2025 the AAI authors. MIT license.

import {
  ASSEMBLYAI_STT_API_KEY_ENV,
  isUniversal35Pro,
  resolveAssemblyAISttSettings,
  STT_CONNECT_RETRY_DELAY_MS,
  STT_FRAME_FLOOR_MS,
} from "@alexkroman1/aai/host-internal";
import { DEFAULT_STT_PROMPT } from "@alexkroman1/aai/internal";
import { ASSEMBLYAI_STT_EU_URL, type AssemblyAISttOptions } from "@alexkroman1/aai/stt";
import { omitUndefined } from "@alexkroman1/aai/utils";
import {
  AssemblyAI,
  type StreamingTranscriber,
  type StreamingTranscriberParams,
  type TurnEvent,
} from "assemblyai";
import { createNanoEvents, type Emitter } from "nanoevents";
import { createAudioSendGate } from "../../_audio-gate.ts";
import { consoleLogger, transcriptField } from "../../logger.ts";
import {
  closeAfterFlush,
  closeOnAbort,
  connectOrThrow,
  createPcmFrameAccumulator,
  createSttSessionShell,
  pickEndpoint,
  requireApiKey,
} from "../_utils.ts";
import {
  createSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../openers.ts";
import { isCommittingTurn, turnWordSpanMs } from "./_assemblyai-turn.ts";
import { createInputLevelLedger, type InputLevelLedger } from "./_input-level-ledger.ts";
import { createSttLivenessWatch } from "./_stt-liveness.ts";

/**
 * The slice of the SDK's `StreamingTranscriber` this adapter drives.
 *
 * @internal
 */
export type AssemblyAITranscriber = Pick<
  StreamingTranscriber,
  "on" | "connect" | "close" | "sendAudio" | "updateConfiguration" | "forceEndpoint"
>;

/**
 * Build the transcriber for one session — the seam a spec hands a fake through
 * (see {@link openAssemblyAI}).
 *
 * @internal
 */
export type CreateAssemblyAITranscriber = (
  apiKey: string,
  params: StreamingTranscriberParams,
) => AssemblyAITranscriber;

/** The production {@link CreateAssemblyAITranscriber}: the real SDK client. */
const sdkTranscriber: CreateAssemblyAITranscriber = (apiKey, params) =>
  new AssemblyAI({ apiKey }).streaming.transcriber(params);

export interface AssemblyAISession extends SttSession {
  /**
   * @internal Test-only: the CURRENT underlying SDK transcriber, for fixture
   * replay. A deaf socket is replaced (`_stt-liveness.ts`), so read it again
   * after a reopen rather than holding the first one.
   */
  readonly _transcriber: AssemblyAITranscriber;
}

function supportsFormatTurns(resolvedSpeechModel: string): boolean {
  return !isUniversal35Pro(resolvedSpeechModel);
}

/**
 * assemblyai@4.36.3 workaround: when a streaming connect attempt fails (e.g.
 * the connect timeout fires), the SDK's `discardPendingSocket()` strips every
 * listener off the half-open socket and then `close()`es it. If the socket is
 * still CONNECTING, ws aborts the handshake and emits `"error"` ("WebSocket
 * was closed before the connection was established") on the *next tick* — by
 * which point no listener is attached, so it escapes as an uncaught exception
 * and can take down the host process. The SDK's own try/catch around
 * `close()` can't see it because the emit is asynchronous.
 *
 * Wrap the method so a one-shot no-op error listener is re-attached to the
 * socket right after the SDK discards it; the async abort error lands there
 * instead of on the process. If the SDK renames its internals the wrapper
 * degrades to a pass-through.
 *
 * @internal Exported for the connect-timeout regression test only.
 */
export function suppressDiscardedSocketError(transcriber: AssemblyAITranscriber): void {
  const internals = transcriber as unknown as {
    socket?: { once?: (event: string, fn: () => void) => unknown };
    discardPendingSocket?: (this: unknown) => void;
  };
  const original = internals.discardPendingSocket;
  if (typeof original !== "function") return;
  internals.discardPendingSocket = function (this: unknown): void {
    // Grab the socket before the SDK nulls it out; attaching the listener
    // after `close()` still wins the race because ws defers the error emit
    // to process.nextTick.
    const socket = internals.socket;
    original.call(this);
    socket?.once?.("error", () => {
      /* swallow ws's async "closed before the connection was established" */
    });
  };
}

/**
 * Best-effort view of the transcriber socket's unsent-byte count, for the
 * audio backpressure gate. The streaming SDK does not expose its WebSocket,
 * so this probes the same private `socket` field
 * {@link suppressDiscardedSocketError} already relies on; if the SDK renames
 * its internals the probe degrades to `undefined` and the gate is skipped.
 */
function transcriberBufferedAmount(transcriber: AssemblyAITranscriber): number | undefined {
  const socket = (transcriber as unknown as { socket?: { bufferedAmount?: unknown } }).socket;
  const buffered = socket?.bufferedAmount;
  return typeof buffered === "number" ? buffered : undefined;
}

/**
 * The streaming endpoint to dial, or `undefined` to leave the SDK's own.
 *
 * An explicit `streamingUrl` wins over `region` — the rule {@link pickEndpoint}
 * owns, shared with the LLM gateway's `gatewayUrl`. The US default is left to
 * the SDK (hence no `default` here), whose own default already carries the
 * versioned path: a stale copy would override an SDK path bump.
 */
function resolveStreamingUrl(opts: AssemblyAISttOptions): string | undefined {
  return pickEndpoint(opts.streamingUrl, opts.region, { eu: ASSEMBLYAI_STT_EU_URL });
}

/**
 * Assemble the SDK's transcriber params from the descriptor options and the
 * per-session open options. Built as a loose record and cast once at the call
 * site: the SDK's param type is a strict string-literal union and, under
 * exactOptionalPropertyTypes, does not accept our widened `string` option
 * types via conditional spreads.
 */
function buildTranscriberParams(
  opts: AssemblyAISttOptions,
  openOpts: SttOpenOptions,
): {
  params: Record<string, unknown>;
  /** Whether a commit must wait for the FORMATTED final — see isCommittingTurn. */
  awaitingFormatted: boolean;
  settings: ReturnType<typeof resolveAssemblyAISttSettings>;
} {
  // Every default lives in resolveAssemblyAISttSettings, which the runtime's
  // "Session mode resolved" log also reads — so the settings reported at
  // startup are the ones dialled here, not a second copy of the same `??`
  // chains. This function only maps them onto the SDK's parameter names.
  const settings = resolveAssemblyAISttSettings(opts);
  const params: Record<string, unknown> = {
    sampleRate: openOpts.sampleRate,
    speechModel: settings.model,
    // Always set: the SDK's 1000 ms default covers socket open *plus* the
    // server's `Begin`, and a healthy handshake can exceed it — see the
    // connect-budget note in sdk/constants.ts. `??` (not `||`) so an
    // explicit 0 survives as "no deadline".
    connectTimeout: settings.connectTimeoutMs,
    maxConnectionRetries: settings.maxConnectRetries,
    connectionRetryDelay: STT_CONNECT_RETRY_DELAY_MS,
    // BOTH endpointing halves are always sent. The service defaults them
    // independently — the minimum from the `mode` preset, the maximum to 1536
    // — so sending only the minimum is how it ends up ABOVE the maximum, at
    // which point the completeness check can never fire before the
    // content-blind force-end has closed the turn and every ending comes from
    // the acoustic fallback that splits utterances. Resolving them together is
    // what makes that regression un-writable; see both constants' docs.
    minTurnSilence: settings.minTurnSilenceMs,
    maxTurnSilence: settings.maxTurnSilenceMs,
  };
  const streamingUrl = resolveStreamingUrl(opts);
  if (streamingUrl) params.websocketBaseUrl = streamingUrl;
  // Language biasing. The resolver fills ["en"] when the agent named none on a
  // Universal-3.5 Pro model (ASSEMBLYAI_STT_DEFAULT_LANGUAGES). It is absent
  // for an explicit `languages: []` (the code-switching opt-in) and for any
  // other model left unset, which was never sent `language_codes` (see the
  // option's doc).
  if (settings.languages) {
    params.languageCodes = settings.languages;
  }
  // Contextual biasing is opt-in: DEFAULT_STT_PROMPT is empty, so an agent
  // that sets no sttPrompt sends no `prompt` at all — as does `sttPrompt: ""`.
  // DEFAULT_STT_PROMPT documents what a useful prompt buys and costs, and why
  // the generic default that briefly lived there was reverted.
  const sttPrompt = openOpts.sttPrompt ?? DEFAULT_STT_PROMPT;
  if (sttPrompt) params.prompt = sttPrompt;
  // Turn formatting. Sent only where it IS a parameter: on the Universal-3.5
  // Pro family formatting is always on, so `formatTurns: false` there is a
  // request this service cannot honour and the caller is told rather than left
  // believing they turned it off.
  const awaitingFormatted = settings.formatTurns === true && supportsFormatTurns(settings.model);
  if (settings.formatTurns !== undefined) {
    if (supportsFormatTurns(settings.model)) {
      params.formatTurns = settings.formatTurns;
    } else {
      consoleLogger.warn(
        `assemblyAIStt({ formatTurns: ${settings.formatTurns} }) is not a parameter on "${settings.model}" — that model formats every turn and the setting is not being sent. Choose a Universal Streaming model to control it.`,
      );
    }
  }
  // The threshold is omitted entirely when voice focus is off — it tunes that
  // filter, and sending it alone reads as if suppression were active.
  if (settings.voiceFocus) {
    params.voiceFocus = settings.voiceFocus;
    params.voiceFocusThreshold = settings.voiceFocusThreshold;
  }
  // Independent of voice focus: the VAD gates frames whether or not the
  // isolation filter ran in front of it.
  if (settings.vadThreshold !== undefined) params.vadThreshold = settings.vadThreshold;
  return { params, awaitingFormatted, settings };
}

export function openAssemblyAI(
  opts: AssemblyAISttOptions = {},
  createTranscriber: CreateAssemblyAITranscriber = sdkTranscriber,
): SttOpener {
  return {
    name: "assemblyai",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(
        openOpts.apiKey,
        ASSEMBLYAI_STT_API_KEY_ENV,
        "AssemblyAI STT",
        (msg) => createSttError("stt_auth_failed", msg),
      );

      const {
        params: transcriberParams,
        awaitingFormatted,
        settings,
      } = buildTranscriberParams(opts, openOpts);
      /**
       * The end-of-turn floor this socket is currently running with.
       *
       * Tracked so `updateEndpointing` can skip a no-op: the rule table is
       * re-evaluated on every STT partial (~5/s while the caller talks) and
       * almost every evaluation lands on the same answer as the last one, so
       * without this the session would send an `UpdateConfiguration` frame per
       * partial for the length of the call.
       */
      let currentMinTurnSilenceMs = settings.minTurnSilenceMs;
      let transcriber = createTranscriber(apiKey, transcriberParams as StreamingTranscriberParams);
      suppressDiscardedSocketError(transcriber);

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      // Levels of the audio this socket has SENT, on the service's own clock —
      // what `inputPeakDbfs` is read from. Per socket: a reconnect restarts
      // the service's clock, and a new session restarts this one with it.
      let levels = createInputLevelLedger(openOpts.sampleRate);
      // Reopens a socket that has gone deaf — see `_stt-liveness.ts`.
      const liveness = createSttLivenessWatch(openOpts.sampleRate, {
        maxTurnSilenceMs: settings.maxTurnSilenceMs,
      });
      /** Frames held while a reopened socket connects; `undefined` when none is connecting. */
      let pending: Int16Array[] | undefined;
      let lastKeyterms: readonly string[] | undefined;
      let reopens = 0;
      const shell = createSttSessionShell({
        emitter,
        teardown: () => transcriber.close(),
      });

      /**
       * `end_of_turn_confidence` off the turn event.
       *
       * Read defensively because the `assemblyai` SDK does not yet declare the
       * field on its turn type — it is on the wire and absent from the `.d.ts`
       * — so a direct property access does not type-check. A narrow `as` to a
       * shape with one `unknown` member keeps that local and honest: nothing is
       * laundered past the checker beyond this field's existence, and the
       * `typeof` guard is what actually admits the value. Delete the cast once
       * the SDK types it.
       */
      const readEndOfTurnConfidence = (event: object): number | undefined => {
        const raw = (event as { end_of_turn_confidence?: unknown }).end_of_turn_confidence;
        return typeof raw === "number" ? raw : undefined;
      };

      const onTurn = (event: TurnEvent, socketLevels: InputLevelLedger): void => {
        if (shell.isClosed()) return;
        liveness.heard(event.end_of_turn === true);
        const text = event.transcript ?? "";
        // Raw turn trace (AAI_DEBUG=1; `debug` is a no-op otherwise). Logged
        // before the empty-text early return and with the service's own flags,
        // so a word that appears in an interim turn and is then revised out of
        // the final one is attributable to STT rather than to the transport's
        // turn aggregation (see pipeline-user-speech.ts's matching trace). In
        // production the transcript is a character count (`transcriptField`).
        const endOfTurnConfidence = readEndOfTurnConfidence(event);
        consoleLogger.debug("AssemblyAI STT turn", {
          ...transcriptField("transcript", text),
          endOfTurn: event.end_of_turn,
          formatted: event.turn_is_formatted,
          endOfTurnConfidence,
        });
        if (text.length === 0) return;
        // Through the shell: this fires from inside the SDK's own turn handler,
        // so a listener that throws would escape as an uncaughtException.
        //
        // The key is OMITTED rather than set to undefined: `exactOptionalPropertyTypes`
        // distinguishes the two, and "the provider said nothing" is the absent case.
        const span = turnWordSpanMs(event);
        const inputPeakDbfs = span && socketLevels.peakDbfs(span.startMs, span.endMs);
        const spokenMs = span && span.endMs - span.startMs;
        const trailingSilenceMs = span && Math.max(0, socketLevels.sentMs() - span.endMs);
        shell.emit(isCommittingTurn(event, awaitingFormatted) ? "final" : "partial", text, {
          ...omitUndefined({ endOfTurnConfidence, inputPeakDbfs, spokenMs, trailingSilenceMs }),
        });
      };

      /** Replaced sockets still flushing their last turn — see `reopen`. */
      const draining = new Set<AssemblyAITranscriber>();
      // Every handler is bound to ITS socket and ledger. A replaced socket's
      // turns still count while it drains (its flush is real speech, often the
      // words that exposed it), but its close and errors no longer end the
      // session.
      const wire = (t: AssemblyAITranscriber, socketLevels: InputLevelLedger): void => {
        t.on("turn", (event) => {
          if (t === transcriber || draining.has(t)) onTurn(event, socketLevels);
        });
        t.on("error", (err) => {
          if (t === transcriber) shell.onSocketError(err);
        });
        t.on("close", (code) => {
          if (t === transcriber) shell.onSocketClose(code);
        });
      };
      wire(transcriber, levels);

      const sendFrame = (frame: Int16Array): void => {
        levels.record(frame);
        transcriber.sendAudio(
          frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
        );
      };

      /** A reopened socket is up: re-send the session's live settings, then the held audio. */
      const adopt = (next: AssemblyAITranscriber): void => {
        if (shell.isClosed() || next !== transcriber) return;
        if (currentMinTurnSilenceMs !== settings.minTurnSilenceMs) {
          next.updateConfiguration({ min_turn_silence: currentMinTurnSilenceMs });
        }
        if (lastKeyterms) next.updateConfiguration({ keyterms_prompt: [...lastKeyterms] });
        const held = pending ?? [];
        pending = undefined;
        for (const frame of held) sendFrame(frame);
      };

      /**
       * Replace a deaf socket. The old one is told to terminate — which flushes
       * any turn it was holding, accepted while it drains — and audio goes to
       * `pending`, seeded with the recent audio the old socket never answered,
       * until the new one is up; then the session's live settings are re-sent.
       * Measured on recorded calls: keeping the old socket's flush heard 54 of
       * 58 utterances, dropping it at once 50, with a duplicate final on 2 of
       * 96 reopens. A failed reopen is a stream error, exactly as the old
       * socket dying would have been.
       */
      const reopen = (): void => {
        const old = transcriber;
        reopens += 1;
        consoleLogger.info("AssemblyAI STT reopened: voiced audio got no turn event", {
          reopens,
        });
        liveness.reopened();
        pending = [...liveness.recent()];
        transcriber = createTranscriber(apiKey, transcriberParams as StreamingTranscriberParams);
        suppressDiscardedSocketError(transcriber);
        levels = createInputLevelLedger(openOpts.sampleRate);
        wire(transcriber, levels);
        const next = transcriber;
        draining.add(old);
        void Promise.resolve(old.close())
          .catch(() => undefined)
          .finally(() => draining.delete(old));
        Promise.resolve()
          .then(() => next.connect())
          .then(() => adopt(next))
          .catch((err: unknown) => {
            if (next === transcriber) shell.onSocketError(err as Error);
          });
      };

      await connectOrThrow(
        "AssemblyAI STT",
        (msg) => createSttError("stt_connect_failed", msg),
        () => transcriber.connect(),
      );

      closeOnAbort(openOpts.signal, shell.close);

      // AssemblyAI streaming requires each audio frame to be 50–1000 ms, but
      // telephony clients (e.g. the tau2 harness) stream standard 20 ms RTP
      // frames. Coalesce inbound PCM before forwarding — see
      // createPcmFrameAccumulator; a sub-50 ms close-time tail is dropped
      // (below AssemblyAI's frame floor).
      const frames = createPcmFrameAccumulator({
        sampleRate: openOpts.sampleRate,
        minFlushMs: STT_FRAME_FLOOR_MS,
        // `slice` copies just the sent bytes; the accumulator is reused.
        send: (frame) => {
          if (pending) {
            pending.push(frame.slice());
            liveness.observe(frame);
            return;
          }
          if (liveness.observe(frame)) {
            reopen();
            return;
          }
          sendFrame(frame);
        },
      });

      // Drop audio frames while the provider link is stalled — mic audio is
      // real-time paced and loss-tolerant; see _audio-gate.ts. Gated before
      // accumulation so a stall doesn't buffer host-side either.
      const audioGate = createAudioSendGate({
        bufferedAmount: () => transcriberBufferedAmount(transcriber),
        label: "AssemblyAI STT",
      });

      const session: AssemblyAISession = {
        sendAudio(pcm: Int16Array) {
          if (shell.isClosed() || audioGate.shouldDrop()) return;
          frames.push(pcm);
        },
        on: shell.on,
        close: closeAfterFlush(shell, frames),
        updateEndpointing(minTurnSilenceMs: number) {
          if (shell.isClosed()) return;
          // CLAMPED to the ceiling this session dialled, not to the shipped
          // default: an agent may raise `maxTurnSilenceMs`, and the invariant
          // is that the floor never passes the ceiling — sending a minimum
          // above the maximum is the measured inversion in
          // `DEFAULT_MIN_TURN_SILENCE_MS`, after which every turn ends on the
          // content-blind fallback that splits utterances. Sub-millisecond
          // values are refused rather than rounded to 0, because 0 on the wire
          // means "use the service default" and would silently hand the window
          // back to the `mode` preset.
          const bounded = Math.round(
            Math.max(1, Math.min(minTurnSilenceMs, settings.maxTurnSilenceMs)),
          );
          if (bounded === currentMinTurnSilenceMs) return;
          currentMinTurnSilenceMs = bounded;
          // A reopening socket gets it once connected.
          if (pending) return;
          // NOTE: snake_case — `updateConfiguration` takes the service's own
          // wire names, unlike the camelCase connect params.
          transcriber.updateConfiguration({ min_turn_silence: bounded });
        },
        updateKeyterms(terms) {
          if (shell.isClosed()) return;
          lastKeyterms = terms;
          if (pending) return;
          // Replaces the session's set — the caller sends all of it every time.
          transcriber.updateConfiguration({ keyterms_prompt: [...terms] });
        },
        forceEndOfTurn() {
          // A socket still connecting has no turn to end.
          if (shell.isClosed() || pending) return;
          // The service's `ForceEndpoint` frame: it ends the turn it is
          // building and emits that turn's final at once — the same `Turn`
          // message a silence window would have produced, so nothing
          // downstream can tell a forced end from an endpointed one. No
          // no-op tracking, unlike `updateEndpointing` above: the transport
          // sends this once per utterance, never per partial.
          transcriber.forceEndpoint();
        },
        get _transcriber() {
          return transcriber;
        },
      };

      return session;
    },
  };
}
