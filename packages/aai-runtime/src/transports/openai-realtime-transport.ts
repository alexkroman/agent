// Copyright 2026 the AAI authors. MIT license.
// OpenAI Realtime API transport — implements Transport. The inbound event
// dispatch is `openai-realtime-events.ts`; the connection/reply state machine
// is `openai-realtime-lifecycle.ts`.

import type { ToolChoice } from "@alexkroman1/aai";
import { LOG_PREVIEW_CHARS, WS_NORMAL_CLOSURE } from "@alexkroman1/aai/host-internal";
import { WS_OPEN } from "@alexkroman1/aai/internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { SessionErrorCode } from "@alexkroman1/aai/protocol";
import type { OpenAIS2sOptions } from "@alexkroman1/aai/s2s";
import { errorMessage } from "@alexkroman1/aai/utils";
import { createAudioSendGate } from "../_audio-gate.ts";
import { uint8ToBase64 } from "../_base64.ts";
import {
  type CreateHeaderWebSocket,
  createWsOpenRace,
  defaultCreateHeaderWebSocket,
  type HeaderWebSocket,
} from "../_ws.ts";
import type { Logger } from "../logger.ts";
import { consoleLogger } from "../logger.ts";
import { OPENAI_REALTIME_CAPABILITIES } from "./capabilities.ts";
import { createEmitError } from "./emit-error.ts";
import {
  createRealtimeMessageHandler,
  createRealtimeTurnBuffers,
} from "./openai-realtime-events.ts";
import { createOpenaiRealtimeLifecycle } from "./openai-realtime-lifecycle.ts";
import { withS2sTurnMetrics } from "./s2s-turn-metrics.ts";
import {
  resolveGreeting,
  resolveSystemPrompt,
  type SkipGreetingOption,
  shouldSkipGreeting,
  type Transport,
  type TransportCallbacks,
  type TransportSessionConfig,
} from "./types.ts";

const DEFAULT_MODEL = "gpt-realtime-2";
const DEFAULT_VOICE = "alloy";
const DEFAULT_URL = "wss://api.openai.com/v1/realtime";

export type OpenaiRealtimeWebSocket = HeaderWebSocket;
export type CreateOpenaiRealtimeWebSocket = CreateHeaderWebSocket;

type OpenaiRealtimeTransportOptions = {
  apiKey: string;
  options: OpenAIS2sOptions;
  sessionConfig: TransportSessionConfig;
  toolSchemas: ToolSchema[];
  toolChoice: ToolChoice;
  callbacks: TransportCallbacks;
  sid: string;
  /** PCM sample rate (Hz) the client captures and sends — must match what we
   *  declare to OpenAI or input audio is interpreted at the wrong speed. */
  inputSampleRate: number;
  /** PCM sample rate (Hz) for synthesized output audio. */
  outputSampleRate: number;
  /**
   * Skip the initial greeting (used for session resume) — a boolean, or a thunk
   * resolved when the greeting would fire. See {@link SkipGreetingOption}: the runtime
   * cannot answer this at construction, because whether a resume recovered
   * anything is only known once its lookups have run.
   */
  skipGreeting?: SkipGreetingOption;
  createWebSocket?: CreateOpenaiRealtimeWebSocket;
  logger?: Logger;
};

/**
 * The full `session.update` sent on open. `instructions` is passed in rather
 * than resolved here so the caller latches exactly what went out.
 */
function buildSessionUpdate(
  opts: OpenaiRealtimeTransportOptions,
  voice: string,
  instructions: string,
): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      output_modalities: ["audio"],
      instructions,
      audio: {
        input: {
          format: { type: "audio/pcm", rate: opts.inputSampleRate },
          turn_detection: { type: "server_vad" },
          transcription: { model: "whisper-1" },
        },
        output: {
          format: { type: "audio/pcm", rate: opts.outputSampleRate },
          voice,
        },
      },
      tools: opts.toolSchemas,
      // The object form maps to OpenAI Realtime's named-function shape.
      tool_choice:
        typeof opts.toolChoice === "string"
          ? opts.toolChoice
          : { type: "function", name: opts.toolChoice.toolName },
    },
  };
}

/**
 * Coalesce the `response.create` that follows tool results into one per tick.
 * Multiple tool results from one turn arrive synchronously, and OpenAI rejects
 * a second `response.create` while one is in flight, which strands the turn.
 */
function createResponseCreateCoalescer(
  send: (payload: Record<string, unknown>) => void,
  log: Logger,
  sid: string,
): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      // A throw here has no caller to land in (microtask) — it would
      // surface as an uncaughtException. Log and swallow.
      try {
        send({ type: "response.create" });
      } catch (err) {
        log.warn("OpenAI Realtime response.create failed", { error: errorMessage(err), sid });
      }
    });
  };
}

export function createOpenaiRealtimeTransport(opts: OpenaiRealtimeTransportOptions): Transport {
  const callbacks = withS2sTurnMetrics(opts.callbacks); // + `metrics.collected` per reply
  const log = opts.logger ?? consoleLogger;
  // The one place "the session is over" is spelled (omitting `fatal` says it).
  const emitError = createEmitError(callbacks);
  const createWs = opts.createWebSocket ?? defaultCreateHeaderWebSocket;
  const model = opts.options.model ?? DEFAULT_MODEL;
  const voice = opts.options.voice ?? DEFAULT_VOICE;
  const baseUrl = opts.options.url ?? DEFAULT_URL;

  let ws: OpenaiRealtimeWebSocket | null = null;
  // Drop mic frames while the provider link is stalled (audio is
  // loss-tolerant; a stalled socket must not queue live speech unboundedly).
  // Only sendUserAudio is gated — control messages always go through.
  const audioGate = createAudioSendGate({
    bufferedAmount: () => ws?.bufferedAmount,
    label: "OpenAI Realtime",
    log,
  });
  const buffers = createRealtimeTurnBuffers();
  // The `instructions` the SERVICE is holding, null before the first
  // `session.update`. Latched only when a frame really went out (`socketOpen`),
  // because a latch on a DROPPED send has no symptom: the next refresh compares
  // equal, declines to send, and leaves the call on the old prompt for good.
  let sentInstructions: string | null = null;

  function socketOpen(): boolean {
    return ws !== null && ws.readyState === WS_OPEN;
  }

  function send(payload: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WS_OPEN) {
      log.debug("OpenAI Realtime send dropped: socket not open", { type: payload.type });
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  const queueResponseCreate = createResponseCreateCoalescer(send, log, opts.sid);

  function sendGreeting(): void {
    // Resolved at the moment it matters, like the pipeline's `onAudioReady`.
    if (shouldSkipGreeting(opts.skipGreeting)) return;
    const greeting = resolveGreeting(opts.sessionConfig.greeting);
    if (!greeting) return;
    // OpenAI Realtime has no native greeting field — trigger it as a one-shot
    // response with custom instructions that override the system prompt for
    // this turn only. Audio + transcript ride the normal response.* events.
    send({
      type: "response.create",
      response: { instructions: `Say exactly: ${JSON.stringify(greeting)}` },
    });
  }

  function sendSessionUpdate(): void {
    const instructions = resolveSystemPrompt(opts.sessionConfig.systemPrompt);
    // Called from the `open` handler, so the socket is open by construction and
    // this latch cannot record a dropped frame.
    sentInstructions = instructions;
    send(buildSessionUpdate(opts, voice, instructions));
  }

  /**
   * Push a changed system prompt to the service — see
   * {@link Transport.refreshSystemPrompt}.
   *
   * Two properties, each answering a way this goes wrong. **Only on a CHANGE**:
   * a `session.update` per turn is a frame the service does not need, and the
   * full update above restates `turn_detection` — re-declaring server VAD under
   * a caller who is already speaking is not worth a barge-in that misses. And an
   * **`instructions`-ONLY patch**: `session.update` merges, so naming the one
   * field that moved leaves the formats, voice, tools and tool choice alone
   * rather than putting all of them back on the wire to change one string.
   *
   * A closed socket is a NO-OP, not a queued write — this transport drops frames
   * on a dead link everywhere else (see `send`).
   */
  function refreshSystemPrompt(): void {
    if (!socketOpen()) return;
    const next = resolveSystemPrompt(opts.sessionConfig.systemPrompt);
    if (next === sentInstructions) return;
    sentInstructions = next;
    send({ type: "session.update", session: { type: "realtime", instructions: next } });
  }

  /**
   * A TURN-level error report. `fatal: false` on every one of them, deliberately:
   * none of these closes the socket, so the conversation goes on — and an absent
   * `fatal` means the session is over, which releases the client's microphone.
   * The one terminal reporter is the close handler, which calls `emitError` with
   * no options — the one spelling of "the session is over" (pipeline-error.ts).
   */
  function reportError(code: SessionErrorCode, message: string): void {
    emitError(code, message, { fatal: false });
  }

  /**
   * Where the connection is, and whether a reply is in flight.
   *
   * Every effect below is a HOW the machine does not know; the machine owns
   * WHEN. `clearTurnBuffers` is wired as an effect rather than called from the
   * paths that end a response — see `openai-realtime-lifecycle.ts`.
   */
  const lifecycle = createOpenaiRealtimeLifecycle({
    replyStarted: (replyId) => callbacks.onReplyStarted(replyId),
    replyCompleted: () => callbacks.report({ type: "reply.completed" }),
    replyCancelled: () => callbacks.report({ type: "reply.cancelled" }),
    cancelResponse: () => send({ type: "response.cancel" }),
    clearTurnBuffers: () => buffers.clear(),
    // No `fatal` key: the socket is gone, so the session really is over.
    reportFatal: (detail) => emitError("connection", detail),
    log: (level, message, fields) => log[level](message, { ...fields, sid: opts.sid }),
  });

  const handleMessage = createRealtimeMessageHandler({
    callbacks,
    lifecycle,
    buffers,
    log,
    reportError,
  });

  async function start(): Promise<void> {
    const url = `${baseUrl}?model=${encodeURIComponent(model)}`;
    log.info("OpenAI Realtime connecting", { url });
    const sock = createWs(url, {
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
      },
    });
    ws = sock;
    // Handlers stay registered for the socket's life; the race routes pre-open
    // failures to the connect and later ones to the session callbacks.
    const connect = createWsOpenRace();

    sock.addEventListener("open", () => {
      connect.markOpen();
      lifecycle.send({ type: "OPEN" });
      sendSessionUpdate();
      sendGreeting();
    });
    sock.addEventListener("message", (ev) => {
      // handleMessage dispatches into session callbacks; a throw escaping a
      // ws 'message' handler would be an uncaughtException — surface it via
      // the session error path instead.
      try {
        handleMessage(ev.data);
      } catch (err) {
        const msg = errorMessage(err);
        log.error("OpenAI Realtime message dispatch failed", { error: msg, sid: opts.sid });
        // Non-fatal: one frame failed to dispatch, the socket is untouched, and
        // the next frame will be handled normally (the in-band `error` handler
        // in openai-realtime-events.ts argues why a fatal frame would be worse).
        reportError("internal", msg);
      }
    });
    sock.addEventListener("close", (ev) => {
      const code = ev.code ?? 0;
      // A close before the open (e.g. an auth rejection that closes rather than
      // errors) must fail the connect — otherwise start() awaits forever.
      if (connect.isOpening()) {
        connect.fail(new Error(`WebSocket closed before open (code: ${code})`));
      }
      // Whether this close is the end of a session or the end of a hang-up is
      // the lifecycle's to know: only `closed` has been asked for.
      lifecycle.send({ type: "CLOSED", code, reason: ev.reason ?? "" });
    });
    sock.addEventListener("error", (ev) => {
      const msg = typeof ev.message === "string" ? ev.message : "WebSocket error";
      if (connect.isOpening()) {
        connect.fail(new Error(msg));
        return;
      }
      if (!lifecycle.reportsErrors()) {
        log.info("OpenAI Realtime error on a finished session", { error: msg });
        return;
      }
      // The `ws` library always follows a fatal socket error with `close`, and
      // the close handler reports THAT as fatal with the code attached.
      // Reporting this one as fatal too would tear the client down (mic
      // released) one event early, for a socket error that may not be terminal.
      reportError("internal", msg);
    });
    await connect.promise;
  }

  async function stop(): Promise<void> {
    lifecycle.send({ type: "STOP" });
    // Normal Closure rather than a statusless frame: the `closed` phase
    // already keeps *our* logs honest, but the peer would otherwise see 1005
    // "No Status Received" and treat a deliberate stop as a dropped socket.
    ws?.close(WS_NORMAL_CLOSURE);
    ws = null;
  }

  return {
    capabilities: OPENAI_REALTIME_CAPABILITIES,
    start,
    stop,
    refreshSystemPrompt,
    sendUserAudio(bytes) {
      if (!ws || ws.readyState !== WS_OPEN || audioGate.shouldDrop()) return;
      ws.send(`{"type":"input_audio_buffer.append","audio":"${uint8ToBase64(bytes)}"}`);
    },
    sendToolResult(callId, result) {
      log.info("OpenAI Realtime sendToolResult", {
        callId,
        resultLen: result.length,
        preview: result.slice(0, LOG_PREVIEW_CHARS),
      });
      send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: result },
      });
      queueResponseCreate();
    },
    cancelReply() {
      // Handled only in `replying`, so there is no in-flight guard here: the
      // state is the guard. It reports nothing — see the `cancelResponse` action.
      lifecycle.send({ type: "CANCEL" });
    },
  };
}
