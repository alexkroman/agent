// Copyright 2025 the AAI authors. MIT license.

import { AssemblyAI, type StreamingTranscriber } from "assemblyai";
import { createNanoEvents, type Emitter } from "nanoevents";
import {
  DEFAULT_MIN_TURN_SILENCE_MS,
  DEFAULT_STT_PROMPT,
  STT_CONNECT_MAX_RETRIES,
  STT_CONNECT_RETRY_DELAY_MS,
  STT_CONNECT_TIMEOUT_MS,
  STT_FRAME_FLOOR_MS,
} from "../../../sdk/constants.ts";
import {
  ASSEMBLYAI_API_KEY_ENV,
  ASSEMBLYAI_STREAMING_EU_URL,
  type AssemblyAIOptions,
} from "../../../sdk/providers/stt/assemblyai.ts";
import {
  makeSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../../../sdk/providers.ts";
import { createAudioSendGate } from "../../_audio-gate.ts";
import { consoleLogger } from "../../runtime-config.ts";
import {
  closeOnAbort,
  connectOrThrow,
  createPcmFrameAccumulator,
  createSessionShell,
  requireApiKey,
} from "../_utils.ts";

export interface AssemblyAISession extends SttSession {
  /** @internal Test-only: exposes the underlying SDK transcriber for fixture replay. */
  readonly _transcriber: StreamingTranscriber;
}

/**
 * `agent_context` is accepted only by the Universal-3.5 Pro streaming
 * family — connection-time is rejected and mid-stream updates are stripped
 * (with a server warning) on every other model. Names cover both the
 * dot- and dash-spelled literals plus the SDK's rt-pro aliases.
 */
const UNIVERSAL_3_5_PRO_MODELS: ReadonlySet<string> = new Set([
  "universal-3-5-pro",
  "u3-rt-pro",
  "u3-rt-pro-beta-1",
  "u3-rt-agent",
]);

function supportsAgentContext(resolvedSpeechModel: string): boolean {
  return UNIVERSAL_3_5_PRO_MODELS.has(resolvedSpeechModel);
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

/** AssemblyAI's `agent_context` cap. Values longer than this are truncated. */
const AGENT_CONTEXT_MAX_CHARS = 1750;

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
 * Assemble the SDK's transcriber params from the descriptor options and the
 * per-session open options. Built as a loose record and cast once at the call
 * site: the SDK's param type is a strict string-literal union and, under
 * exactOptionalPropertyTypes, does not accept our widened `string` option
 * types via conditional spreads.
 */
function buildTranscriberParams(
  opts: AssemblyAIOptions,
  openOpts: SttOpenOptions,
): { params: Record<string, unknown>; agentContextCapable: boolean } {
  const speechModel = opts.model ?? "universal-3-5-pro";
  const agentContextCapable = supportsAgentContext(speechModel);
  const initialAgentContext = agentContextCapable
    ? normalizeAgentContext(openOpts.agentContext ?? "")
    : undefined;
  // Voice focus (noise suppression); defaults to near-field. "off"/"" disables.
  const requestedVoiceFocus = opts.voiceFocus ?? "near-field";
  const voiceFocus = requestedVoiceFocus === "off" ? "" : requestedVoiceFocus;
  const params: Record<string, unknown> = {
    sampleRate: openOpts.sampleRate,
    speechModel,
    // Always set: the SDK's 1000 ms default covers socket open *plus* the
    // server's `Begin`, and a healthy handshake can exceed it — see the
    // connect-budget note in sdk/constants.ts. `??` (not `||`) so an
    // explicit 0 survives as "no deadline".
    connectTimeout: opts.connectTimeoutMs ?? STT_CONNECT_TIMEOUT_MS,
    maxConnectionRetries: opts.maxConnectRetries ?? STT_CONNECT_MAX_RETRIES,
    connectionRetryDelay: STT_CONNECT_RETRY_DELAY_MS,
    // Endpointing lives here, not in the transport: the service holds its
    // `final` until this much end-of-turn silence has passed, so a disfluent
    // utterance's pauses aggregate service-side. See the constant's doc.
    minTurnSilence: opts.minTurnSilenceMs ?? DEFAULT_MIN_TURN_SILENCE_MS,
  };
  // EU data residency: point the SDK's streaming socket at the EU host.
  // The US default is left to the SDK (its default already carries the
  // versioned path), so only the EU case names an endpoint here.
  if (opts.region === "eu") params.websocketBaseUrl = ASSEMBLYAI_STREAMING_EU_URL;
  // Contextual biasing is opt-in: DEFAULT_STT_PROMPT is empty, so an agent
  // that sets no sttPrompt sends no `prompt` at all — as does `sttPrompt: ""`.
  // DEFAULT_STT_PROMPT documents what a useful prompt buys and costs.
  const sttPrompt = openOpts.sttPrompt ?? DEFAULT_STT_PROMPT;
  if (sttPrompt) params.prompt = sttPrompt;
  if (initialAgentContext !== undefined) params.agentContext = initialAgentContext;
  if (voiceFocus) params.voiceFocus = voiceFocus;
  return { params, agentContextCapable };
}

export function openAssemblyAI(opts: AssemblyAIOptions = {}): SttOpener {
  return {
    name: "assemblyai",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(
        openOpts.apiKey,
        ASSEMBLYAI_API_KEY_ENV,
        "AssemblyAI STT",
        (msg) => makeSttError("stt_auth_failed", msg),
      );

      const client = new AssemblyAI({ apiKey });
      const { params: transcriberParams, agentContextCapable } = buildTranscriberParams(
        opts,
        openOpts,
      );
      const transcriber = client.streaming.transcriber(
        transcriberParams as Parameters<typeof client.streaming.transcriber>[0],
      );
      suppressDiscardedSocketError(transcriber);

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      const shell = createSessionShell({
        makeStreamError: (msg) => makeSttError("stt_stream_error", msg),
        emitError: (err) => emitter.emit("error", err),
        // A provider-initiated close ends the transcript stream — see the option doc.
        cleanCloseIsFatal: true,
        teardown: () => transcriber.close(),
      });

      transcriber.on("turn", (event) => {
        if (shell.isClosed()) return;
        const text = event.transcript ?? "";
        // Raw turn trace (AAI_DEBUG=1; `debug` is a no-op otherwise). Logged
        // before the empty-text early return and with the service's own flags,
        // so a word that appears in an interim turn and is then revised out of
        // the final one is attributable to STT rather than to the transport's
        // turn aggregation (see pipeline-user-speech.ts's matching trace).
        consoleLogger.debug("AssemblyAI STT turn", {
          transcript: text,
          endOfTurn: event.end_of_turn,
          formatted: event.turn_is_formatted,
        });
        if (text.length === 0) return;
        emitter.emit(event.end_of_turn ? "final" : "partial", text);
      });

      transcriber.on("error", (err) => shell.onSocketError(err));
      transcriber.on("close", (code) => shell.onSocketClose(code));

      await connectOrThrow(
        "AssemblyAI STT",
        (msg) => makeSttError("stt_connect_failed", msg),
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
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close: () => {
          if (!shell.isClosed()) frames.flush();
          return shell.close();
        },
        updateAgentContext(text: string) {
          if (!agentContextCapable || shell.isClosed()) return;
          const normalized = normalizeAgentContext(text);
          if (normalized === undefined) return;
          // NOTE: the wire/update-message field is snake_case (`agent_context`),
          // unlike the connect-time constructor param (`agentContext`).
          transcriber.updateConfiguration({ agent_context: normalized });
        },
        _transcriber: transcriber,
      };

      return session;
    },
  };
}
