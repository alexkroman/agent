// Copyright 2025 the AAI authors. MIT license.

import {
  ASSEMBLYAI_STT_API_KEY_ENV,
  createSttError,
  describeKeytermDrops,
  isUniversal35Pro,
  MAX_KEYTERM_CHARS,
  MAX_KEYTERMS,
  normalizeKeyterms,
  resolveAssemblyAISttSettings,
  STT_CONNECT_RETRY_DELAY_MS,
  STT_FRAME_FLOOR_MS,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "@alexkroman1/aai/host-internal";
import { DEFAULT_STT_PROMPT } from "@alexkroman1/aai/internal";
import { ASSEMBLYAI_STT_EU_URL, type AssemblyAISttOptions } from "@alexkroman1/aai/stt";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { AssemblyAI, type StreamingTranscriber } from "assemblyai";
import { createNanoEvents, type Emitter } from "nanoevents";
import { createAudioSendGate } from "../../_audio-gate.ts";
import { consoleLogger } from "../../runtime-config.ts";
import {
  closeAfterFlush,
  closeOnAbort,
  connectOrThrow,
  createPcmFrameAccumulator,
  createSttSessionShell,
  pickEndpoint,
  requireApiKey,
} from "../_utils.ts";
import { isCommittingTurn, wordConfidences } from "./_assemblyai-turn.ts";

export interface AssemblyAISession extends SttSession {
  /** @internal Test-only: exposes the underlying SDK transcriber for fixture replay. */
  readonly _transcriber: StreamingTranscriber;
}

/**
 * `agent_context` is accepted only by the Universal-3.5 Pro streaming family —
 * connection-time is rejected and mid-stream updates are stripped (with a
 * server warning) on every other model. `format_turns` is the mirror image:
 * accepted everywhere EXCEPT that family, where formatting is always on and is
 * not a parameter at all. One predicate answers both, and it lives in the SDK
 * beside the descriptor so the model-name list has one home.
 */
function supportsAgentContext(resolvedSpeechModel: string): boolean {
  return isUniversal35Pro(resolvedSpeechModel);
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
export function suppressDiscardedSocketError(transcriber: StreamingTranscriber): void {
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
function transcriberBufferedAmount(transcriber: StreamingTranscriber): number | undefined {
  const socket = (transcriber as unknown as { socket?: { bufferedAmount?: unknown } }).socket;
  const buffered = socket?.bufferedAmount;
  return typeof buffered === "number" ? buffered : undefined;
}

/**
 * AssemblyAI's documented `agent_context` cap ("your agent's most recent
 * spoken reply, up to about 1,500 characters"); the service clips anything
 * longer, in an unspecified direction.
 *
 * That direction is the whole reason to trim host-side at exactly this value
 * rather than above it. This constant was 1750, which left a 250-character
 * band where our own tail-preserving trim passed the value through and the
 * SERVICE decided what to drop — and if it clips the tail, it drops the
 * trailing question, which is the one part worth sending (see
 * {@link normalizeAgentContext}). Trimming at the documented cap keeps the
 * decision here.
 */
const AGENT_CONTEXT_MAX_CHARS = 1500;

/**
 * Cap `text` at {@link AGENT_CONTEXT_MAX_CHARS}; `undefined` for
 * empty/whitespace-only text.
 *
 * Keeps the **tail**, not the head. The docs say to "trim long agent replies
 * down to the substantive question", and a voice agent's question lands at the
 * end of its reply ("…so, what's your email address?") — that trailing question
 * is the whole reason to send context, and slicing from the front is exactly
 * what would drop it.
 */
function normalizeAgentContext(text: string): string | undefined {
  if (text.trim().length === 0) return;
  return text.length > AGENT_CONTEXT_MAX_CHARS ? text.slice(-AGENT_CONTEXT_MAX_CHARS) : text;
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
  agentContextCapable: boolean;
  /** The connect-time keyterms, which a mid-stream `undefined` restores. */
  baseKeyterms: readonly string[];
  /** Whether a commit must wait for the FORMATTED final — see isCommittingTurn. */
  awaitingFormatted: boolean;
} {
  // Every default lives in resolveAssemblyAISttSettings, which the runtime's
  // "Session mode resolved" log also reads — so the settings reported at
  // startup are the ones dialled here, not a second copy of the same `??`
  // chains. This function only maps them onto the SDK's parameter names.
  const settings = resolveAssemblyAISttSettings(opts);
  const agentContextCapable = supportsAgentContext(settings.model);
  // The DESCRIPTOR's context wins over the host's seed. They are two different
  // claims — `assemblyAIStt({ agentContext })` is what the application knows
  // about this call, `openOpts.agentContext` is the greeting the runtime is
  // about to speak — and the author's own is the more specific of the two.
  // Either way the first spoken reply replaces it (see `updateAgentContext`).
  const initialAgentContext = agentContextCapable
    ? normalizeAgentContext(settings.agentContext ?? openOpts.agentContext ?? "")
    : undefined;
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
  // Language biasing. Sent only when the agent asked for it: an absent
  // `language_codes` keeps the model's native code-switching, which is the
  // right default for a multilingual line and the wrong one for a monolingual
  // one (see the option's doc).
  if (settings.languages) {
    params.languageCodes = settings.languages;
  }
  // Contextual biasing is opt-in: DEFAULT_STT_PROMPT is empty, so an agent
  // that sets no sttPrompt sends no `prompt` at all — as does `sttPrompt: ""`.
  // DEFAULT_STT_PROMPT documents what a useful prompt buys and costs, and why
  // the generic default that briefly lived there was reverted.
  const sttPrompt = openOpts.sttPrompt ?? DEFAULT_STT_PROMPT;
  if (sttPrompt) params.prompt = sttPrompt;
  if (initialAgentContext !== undefined) params.agentContext = initialAgentContext;
  // Keyterms. Already normalized by `resolveAssemblyAISttSettings` (so the
  // startup line reports what goes on the wire); absent means the agent
  // declared none, and an empty `keyterms_prompt` at CONNECT would mean
  // nothing anyway — clearing biasing is only a mid-stream act.
  const baseKeyterms = settings.keyterms ?? [];
  if (baseKeyterms.length > 0) params.keytermsPrompt = [...baseKeyterms];
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
  return { params, agentContextCapable, baseKeyterms, awaitingFormatted };
}

/** Warn once per open about keyterms this session is NOT sending, and why. */
function warnDroppedKeyterms(declared: readonly string[] | undefined): void {
  const reasons = describeKeytermDrops(normalizeKeyterms(declared ?? []).dropped);
  if (reasons === undefined) return;
  consoleLogger.warn(
    `assemblyAIStt: ${reasons}. The service ignores a keyterm over ${MAX_KEYTERM_CHARS} characters and REFUSES a connect carrying more than ${MAX_KEYTERMS}, so these were dropped rather than sent.`,
  );
}

export function openAssemblyAI(opts: AssemblyAISttOptions = {}): SttOpener {
  return {
    name: "assemblyai",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(
        openOpts.apiKey,
        ASSEMBLYAI_STT_API_KEY_ENV,
        "AssemblyAI STT",
        (msg) => createSttError("stt_auth_failed", msg),
      );

      const client = new AssemblyAI({ apiKey });
      const {
        params: transcriberParams,
        agentContextCapable,
        baseKeyterms,
        awaitingFormatted,
      } = buildTranscriberParams(opts, openOpts);
      warnDroppedKeyterms(opts.keyterms);
      const transcriber = client.streaming.transcriber(
        transcriberParams as Parameters<typeof client.streaming.transcriber>[0],
      );
      suppressDiscardedSocketError(transcriber);

      // What the service currently believes the keyterms are, as the key
      // `updateKeyterms` compares against. Seeded with the connect-time list so
      // a first turn under a dialog state that declares none sends nothing.
      let sentKeyterms = baseKeyterms.join("\u0000");

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
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

      transcriber.on("turn", (event) => {
        if (shell.isClosed()) return;
        const text = event.transcript ?? "";
        // Raw turn trace (AAI_DEBUG=1; `debug` is a no-op otherwise). Logged
        // before the empty-text early return and with the service's own flags,
        // so a word that appears in an interim turn and is then revised out of
        // the final one is attributable to STT rather than to the transport's
        // turn aggregation (see pipeline-user-speech.ts's matching trace).
        const endOfTurnConfidence = readEndOfTurnConfidence(event);
        // The two WORD-confidence statistics, which are a different question
        // from the end-of-turn one beside them: not "has the caller finished"
        // but "was what they said heard correctly". `AgentDef.lowConfidence`
        // is the one policy that reads them.
        const heard = wordConfidences(event.words);
        consoleLogger.debug("AssemblyAI STT turn", {
          transcript: text,
          endOfTurn: event.end_of_turn,
          formatted: event.turn_is_formatted,
          endOfTurnConfidence,
          ...heard,
        });
        if (text.length === 0) return;
        // Through the shell: this fires from inside the SDK's own turn handler,
        // so a listener that throws would escape as an uncaughtException.
        //
        // The key is OMITTED rather than set to undefined: `exactOptionalPropertyTypes`
        // distinguishes the two, and "the provider said nothing" is the absent case.
        shell.emit(isCommittingTurn(event, awaitingFormatted) ? "final" : "partial", text, {
          ...omitUndefined({ endOfTurnConfidence }),
          ...heard,
        });
      });

      transcriber.on("error", (err) => shell.onSocketError(err));
      transcriber.on("close", (code) => shell.onSocketClose(code));

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
        send: (frame) =>
          transcriber.sendAudio(
            frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
          ),
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
        updateAgentContext(text: string) {
          if (!agentContextCapable || shell.isClosed()) return;
          const normalized = normalizeAgentContext(text);
          if (normalized === undefined) return;
          // NOTE: the wire/update-message field is snake_case (`agent_context`),
          // unlike the connect-time constructor param (`agentContext`).
          transcriber.updateConfiguration({ agent_context: normalized });
        },
        updateKeyterms(keyterms: readonly string[] | undefined) {
          if (shell.isClosed()) return;
          // `undefined` RESTORES the connect-time set — the contract a phase
          // ending depends on, since a state that narrowed the vocabulary must
          // not leave it narrowed for the rest of the call. `[]` from a caller
          // is a different claim and passes straight through as "clear".
          const next = keyterms === undefined ? baseKeyterms : normalizeKeyterms(keyterms).terms;
          // Compared as a STRING because this is called once per agent turn and
          // the overwhelming majority of those change nothing; a wire message
          // per turn for an unchanged list is pure noise on the socket that is
          // also carrying audio. NUL-joined rather than space-joined: a keyterm
          // is often several words, so a space would make ["a b"] and
          // ["a", "b"] one key.
          const key = next.join("\u0000");
          if (key === sentKeyterms) return;
          sentKeyterms = key;
          transcriber.updateConfiguration({ keyterms_prompt: [...next] });
        },
        _transcriber: transcriber,
      };

      return session;
    },
  };
}
