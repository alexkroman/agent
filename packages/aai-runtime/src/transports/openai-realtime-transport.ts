// Copyright 2026 the AAI authors. MIT license.
// OpenAI Realtime API transport — implements Transport.

import type { ToolChoice } from "@alexkroman1/aai";
import { LOG_PREVIEW_CHARS, WS_NORMAL_CLOSURE, WS_OPEN } from "@alexkroman1/aai/host-internal";
import { toArgsRecord } from "@alexkroman1/aai/internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { SessionErrorCode } from "@alexkroman1/aai/protocol";
import type { OpenAIS2sOptions } from "@alexkroman1/aai/s2s";
import { errorMessage, isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import { createAudioSendGate } from "../_audio-gate.ts";
import { base64ToUint8, uint8ToBase64 } from "../_base64.ts";
import {
  type CreateHeaderWebSocket,
  createWsOpenRace,
  defaultCreateHeaderWebSocket,
  type HeaderWebSocket,
} from "../_ws.ts";
import type { Logger } from "../runtime-config.ts";
import { consoleLogger } from "../runtime-config.ts";
import { createOpenaiRealtimeLifecycle } from "./openai-realtime-lifecycle.ts";
import { createEmitError } from "./pipeline-error.ts";
import {
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

export function createOpenaiRealtimeTransport(opts: OpenaiRealtimeTransportOptions): Transport {
  const log = opts.logger ?? consoleLogger;
  // The one place "the session is over" is spelled — omitting `fatal` is what
  // says it, so it is worth having exactly one function that knows that.
  const emitError = createEmitError(opts.callbacks);
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
  const agentTranscriptBuffers = new Map<string, string>();
  type ToolBuffer = { callId: string; name: string; argsBuffer: string };
  const toolBuffers = new Map<string, ToolBuffer>();
  let responseCreateQueued = false;

  function send(payload: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WS_OPEN) {
      log.debug("OpenAI Realtime send dropped: socket not open", { type: payload.type });
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function sendGreeting(): void {
    // Resolved at the moment it matters, like the pipeline's `onAudioReady`.
    if (shouldSkipGreeting(opts.skipGreeting)) return;
    const greeting = opts.sessionConfig.greeting;
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
    send({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        instructions: opts.sessionConfig.systemPrompt,
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
    });
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

  function clearTurnBuffers(): void {
    agentTranscriptBuffers.clear();
    toolBuffers.clear();
  }

  /**
   * Where the connection is, and whether a reply is in flight.
   *
   * Every effect below is a HOW the machine does not know; the machine owns
   * WHEN. Note `clearTurnBuffers` is wired as an effect rather than called from
   * the three paths that used to call it — see `openai-realtime-lifecycle.ts`.
   */
  const lifecycle = createOpenaiRealtimeLifecycle({
    replyStarted: (replyId) => opts.callbacks.onReplyStarted(replyId),
    replyCompleted: () => opts.callbacks.report({ type: "reply.completed" }),
    replyCancelled: () => opts.callbacks.report({ type: "reply.cancelled" }),
    cancelResponse: () => send({ type: "response.cancel" }),
    clearTurnBuffers,
    // No `fatal` key: the socket is gone, so the session really is over.
    reportFatal: (detail) => emitError("connection", detail),
    log: (level, message, fields) => log[level](message, { ...fields, sid: opts.sid }),
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
        // the next frame will be handled normally. See handleErrorEvent below
        // for why a fatal frame here would be worse than the dropped frame.
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
      handleClose(code, ev.reason ?? "");
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
      // handleClose reports THAT as fatal with the code attached. Reporting this
      // one as fatal too tore the client down (mic released) one event early,
      // for a socket error that may not even be terminal.
      reportError("internal", msg);
    });
    await connect.promise;
  }

  function asString(v: unknown): string {
    return typeof v === "string" ? v : "";
  }

  function handleAudioDelta(obj: Record<string, unknown>): void {
    if (typeof obj.delta === "string") {
      // `log`, not the module default: a drop here is this session's.
      opts.callbacks.onAudioChunk(base64ToUint8(obj.delta, log));
    }
  }

  function handleUserTranscript(obj: Record<string, unknown>): void {
    if (typeof obj.transcript === "string") {
      opts.callbacks.report({ type: "user-transcript.committed", text: obj.transcript });
    }
  }

  function handleResponseCreated(obj: Record<string, unknown>): void {
    const resp = obj.response as { id?: unknown } | undefined;
    lifecycle.send({ type: "REPLY_STARTED", replyId: asString(resp?.id) });
  }

  function handleAgentTranscriptDelta(obj: Record<string, unknown>): void {
    const id = asString(obj.item_id);
    const delta = asString(obj.delta);
    agentTranscriptBuffers.set(id, (agentTranscriptBuffers.get(id) ?? "") + delta);
  }

  function handleAgentTranscriptDone(obj: Record<string, unknown>): void {
    const id = asString(obj.item_id);
    const text = agentTranscriptBuffers.get(id) ?? "";
    agentTranscriptBuffers.delete(id);
    if (text) opts.callbacks.report({ type: "agent-transcript.committed", text });
  }

  function handleResponseDone(): void {
    lifecycle.send({ type: "REPLY_DONE" });
  }

  function handleErrorEvent(obj: Record<string, unknown>): void {
    const err = obj.error as { message?: unknown } | undefined;
    const message = typeof err?.message === "string" ? err.message : "OpenAI Realtime error";
    log.warn("OpenAI Realtime error event", { error: obj.error });
    // The turn buffers are NOT cleared here, and that is the same argument as
    // the paragraph below one step further: the response this error interrupts
    // is still running, so its transcript buffer is live state rather than turn
    // residue. Clearing it left the later `…transcript.done` reading `""`,
    // which suppresses the emit — the caller heard the whole reply, the client
    // showed no transcript for it, and nothing entered history. Only a response
    // that really ended (`response.done`, a cancel, a server-VAD barge-in) may
    // discard them.
    // An in-band `error` event leaves the socket open and the session usable —
    // OpenAI sends them for recoverable conditions (a response requested while
    // one is active, an unknown field). `onError` defaults to FATAL, and a fatal
    // frame makes aai-ui release the microphone and end the call, so a
    // recoverable complaint silently cost the user their mic while this
    // transport kept relaying replies. Session death is handleClose's to report.
    reportError("internal", message);
  }

  function handleOutputItemAdded(obj: Record<string, unknown>): void {
    const item = obj.item as
      | { id?: string; type?: string; name?: string; call_id?: string }
      | undefined;
    log.info("OpenAI Realtime output_item.added", {
      itemType: item?.type,
      name: item?.name,
      callId: item?.call_id,
    });
    if (item?.type !== "function_call" || !item.id) return;
    toolBuffers.set(item.id, {
      callId: item.call_id ?? "",
      name: item.name ?? "",
      argsBuffer: "",
    });
  }

  function handleFunctionCallArgsDelta(obj: Record<string, unknown>): void {
    const id = asString(obj.item_id);
    const delta = asString(obj.delta);
    const buf = toolBuffers.get(id);
    if (buf) buf.argsBuffer += delta;
  }

  function parseToolArgs(argsStr: string, name: string, callId: string): Record<string, unknown> {
    if (!argsStr) return {};
    const parsed = safeJsonParse(argsStr);
    // `undefined` is safeJsonParse's malformed-input sentinel (JSON cannot
    // encode it), so this warns on exactly the inputs the old catch did —
    // valid-but-non-object args still fall through to {} without a warning.
    if (parsed === undefined) {
      log.warn("OpenAI Realtime: invalid tool args JSON", { name, callId });
      return {};
    }
    return toArgsRecord(parsed);
  }

  function handleFunctionCallArgsDone(obj: Record<string, unknown>): void {
    const id = asString(obj.item_id);
    const buf = toolBuffers.get(id);
    toolBuffers.delete(id);
    const callId = asString(obj.call_id) || (buf?.callId ?? "");
    const name = asString(obj.name) || (buf?.name ?? "");
    const argsStr = asString(obj.arguments) || (buf?.argsBuffer ?? "");
    log.info("OpenAI Realtime tool call", { name, callId, args: argsStr });
    const args = parseToolArgs(argsStr, name, callId);
    opts.callbacks.report({ type: "tool.called", toolCallId: callId, toolName: name, args });
  }

  function handleMessage(data: unknown): void {
    const raw = safeJsonParse(String(data));
    if (raw === undefined) {
      log.warn("OpenAI Realtime: invalid JSON");
      return;
    }
    if (!isRecord(raw)) return;
    const obj = raw;
    switch (obj.type) {
      case "response.output_audio.delta":
        handleAudioDelta(obj);
        return;
      case "response.output_audio.done":
        opts.callbacks.report({ type: "audio.completed" });
        return;
      case "input_audio_buffer.speech_started":
        // Only `replying` acts on this — under server VAD it is a barge-in, and
        // the lifecycle reports the cancellation the client needs to flush its
        // buffered audio with. The speaking edge is reported either way.
        lifecycle.send({ type: "SPEECH_STARTED" });
        opts.callbacks.report({ type: "speech.started" });
        return;
      case "input_audio_buffer.speech_stopped":
        opts.callbacks.report({ type: "speech.stopped" });
        return;
      case "conversation.item.input_audio_transcription.completed":
        handleUserTranscript(obj);
        return;
      case "response.created":
        handleResponseCreated(obj);
        return;
      case "response.output_audio_transcript.delta":
        handleAgentTranscriptDelta(obj);
        return;
      case "response.output_audio_transcript.done":
        handleAgentTranscriptDone(obj);
        return;
      case "response.done":
        handleResponseDone();
        return;
      case "response.output_item.added":
        handleOutputItemAdded(obj);
        return;
      case "response.function_call_arguments.delta":
        handleFunctionCallArgsDelta(obj);
        return;
      case "response.function_call_arguments.done":
        handleFunctionCallArgsDone(obj);
        return;
      case "error":
        handleErrorEvent(obj);
        return;
      default:
        log.debug("OpenAI Realtime: unhandled event", { type: obj.type });
        return;
    }
  }

  function handleClose(code: number, reason: string): void {
    // Whether this close is the end of a session or the end of a hang-up is the
    // lifecycle's to know: only `closed` has been asked for.
    lifecycle.send({ type: "CLOSED", code, reason });
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
    start,
    stop,
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
      // Multiple tool results from one turn arrive synchronously; coalesce them
      // into a single response.create per tick. OpenAI rejects a second
      // response.create while one is in flight, which strands the turn.
      if (!responseCreateQueued) {
        responseCreateQueued = true;
        queueMicrotask(() => {
          responseCreateQueued = false;
          // A throw here has no caller to land in (microtask) — it would
          // surface as an uncaughtException. Log and swallow.
          try {
            send({ type: "response.create" });
          } catch (err) {
            log.warn("OpenAI Realtime response.create failed", {
              error: errorMessage(err),
              sid: opts.sid,
            });
          }
        });
      }
    },
    cancelReply() {
      // Handled only in `replying`, so the old `if (!replyInFlight) return`
      // guard is the state rather than a latch. It reports nothing — see the
      // `cancelResponse` action.
      lifecycle.send({ type: "CANCEL" });
    },
  };
}
