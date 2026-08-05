// Copyright 2025 the AAI authors. MIT license.
/**
 * Speech-to-Speech WebSocket client for AssemblyAI's S2S API.
 */

import { z } from "zod";
import type { ToolSchema } from "../sdk/_internal-types.ts";
import { LOG_PREVIEW_CHARS, WS_NORMAL_CLOSURE, WS_OPEN } from "../sdk/constants.ts";
import { errorMessage, safeJsonParse } from "../sdk/utils.ts";
import { createAudioSendGate } from "./_audio-gate.ts";
import { base64ToUint8, uint8ToBase64 } from "./_base64.ts";
import {
  countReplyAudio,
  createReplyAudit,
  type ReplyAudit,
  replyAnomaly,
  replyAuditFields,
  resetReplyAudit,
} from "./_s2s-reply.ts";
import {
  type CreateHeaderWebSocket,
  createWsOpenRace,
  defaultCreateHeaderWebSocket,
  type HeaderWebSocket,
} from "./_ws.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import { consoleLogger, debugLoggingEnabled } from "./runtime-config.ts";

export type S2sWebSocket = HeaderWebSocket;
export type CreateS2sWebSocket = CreateHeaderWebSocket;
export const defaultCreateS2sWebSocket: CreateS2sWebSocket = defaultCreateHeaderWebSocket;

// ── Zod schemas for S2S server messages ─────────────────────────────────

const S2sMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.ready"), session_id: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("session.updated"),
      config: z.object({ id: z.string().optional() }).passthrough().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("input.speech.started") }),
  z.object({ type: z.literal("input.speech.stopped") }),
  z.object({ type: z.literal("transcript.user"), item_id: z.string(), text: z.string() }),
  // Live partial of the current user utterance. `text` is the FULL transcript
  // so far (each delta supersedes the previous one for an item_id), not an
  // increment — so it is passed straight through, never concatenated.
  //
  // The two docs pages disagree on the field name: the events reference says
  // `text`, the message-sequence page's example says `delta`. Accept either,
  // preferring the events reference, exactly as `tool.call` below does for
  // `arguments`/`args` — a name mismatch here is silent (the union rejects the
  // frame and it is dropped as unrecognised), which is how live captions went
  // missing in S2S mode in the first place.
  z
    .object({
      type: z.literal("transcript.user.delta"),
      item_id: z.string().optional(),
      text: z.string().optional(),
      delta: z.string().optional(),
    })
    .transform((m) => ({ type: m.type, text: m.text ?? m.delta ?? "" })),
  z.object({ type: z.literal("reply.started"), reply_id: z.string() }),
  // `transcript.agent.delta` is deliberately absent: the events reference
  // documents it, but the live service sends none — see `_s2s-reply.ts`.
  z.object({
    type: z.literal("transcript.agent"),
    text: z.string(),
    reply_id: z.string().optional().default(""),
    item_id: z.string().optional().default(""),
    interrupted: z.boolean().optional().default(false),
  }),
  // AssemblyAI's S2S protocol delivers tool args under `arguments`; older
  // implementations and our internal tests use `args`. Accept either, with
  // `arguments` taking precedence so the live wire format wins.
  z
    .object({
      type: z.literal("tool.call"),
      call_id: z.string(),
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional(),
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .transform((m) => ({
      type: m.type,
      call_id: m.call_id,
      name: m.name,
      args: m.arguments ?? m.args ?? {},
    })),
  z.object({ type: z.literal("reply.done"), status: z.string().optional() }),
  z.object({ type: z.literal("session.error"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

type S2sServerMessage = z.infer<typeof S2sMessageSchema>;

function parseS2sMessage(obj: Record<string, unknown>): S2sServerMessage | undefined {
  const result = S2sMessageSchema.safeParse(obj);
  return result.success ? result.data : undefined;
}

/**
 * Per-connection dispatch state. Used to dedup events that the upstream S2S
 * service may emit more than once for a single logical turn (e.g. repeated
 * `input.speech.stopped` after the VAD flips).
 */
type DispatchState = { speechActive: boolean; reply: ReplyAudit };

type DispatchContext = {
  log: Logger;
  sid?: string;
};

function sidFields(ctx: DispatchContext): { sid?: string } {
  return ctx.sid !== undefined ? { sid: ctx.sid } : {};
}

/**
 * Report what the finished reply actually delivered, then advance the session.
 *
 * The audit fields are what make an empty-looking reply diagnosable: without
 * them a reply that streamed audio and sent no transcript is identical in the
 * log to one that produced nothing. See `_s2s-reply.ts`.
 */
function dispatchReplyDone(
  callbacks: S2sCallbacks,
  status: string,
  state: DispatchState,
  ctx: DispatchContext,
): void {
  // Logged before the client-facing dedup in SessionCore, so a stalled session
  // can be checked against the raw arrivals.
  const audit = replyAuditFields(state.reply);
  ctx.log.info("S2S << reply.done", { ...sidFields(ctx), status, ...audit });
  const anomaly = replyAnomaly(state.reply, status);
  if (anomaly !== undefined) ctx.log.warn(anomaly, { ...sidFields(ctx), ...audit });
  // A reply that sent no `transcript.agent` commits nothing to history: there
  // is no salvage path. Reconstructing the text from `transcript.agent.delta`
  // was tried and removed — the service sends no deltas either, so the
  // accumulator was always empty (see `_s2s-reply.ts`).
  if (status === "interrupted") callbacks.onCancelled();
  else callbacks.onReplyDone();
}

function dispatchS2sMessage(
  callbacks: S2sCallbacks,
  msg: S2sServerMessage,
  state: DispatchState,
  ctx: DispatchContext,
): void {
  switch (msg.type) {
    case "session.ready":
      callbacks.onSessionReady(msg.session_id);
      break;
    case "session.updated":
      // The S2S API conveys the session id via `config.id` in the success
      // path (no separate `session.ready` is emitted); capturing it here is
      // required for resume on transient close.
      if (msg.config?.id !== undefined) callbacks.onSessionReady(msg.config.id);
      break;
    case "input.speech.started":
      if (!state.speechActive) {
        state.speechActive = true;
        callbacks.onSpeechStarted();
      }
      break;
    case "input.speech.stopped":
      if (state.speechActive) {
        state.speechActive = false;
        callbacks.onSpeechStopped();
      }
      break;
    case "transcript.user":
      callbacks.onUserTranscript(msg.text);
      break;
    case "transcript.user.delta":
      callbacks.onUserTranscriptPartial(msg.text);
      break;
    case "reply.started":
      // A new reply supersedes the last one's tally.
      resetReplyAudit(state.reply);
      callbacks.onReplyStarted(msg.reply_id);
      break;
    case "transcript.agent":
      state.reply.sawFinal = true;
      callbacks.onAgentTranscript(msg.text, msg.interrupted);
      break;
    case "tool.call":
      state.reply.sawToolCall = true;
      callbacks.onToolCall(msg.call_id, msg.name, msg.args);
      break;
    case "reply.done":
      dispatchReplyDone(callbacks, msg.status ?? "completed", state, ctx);
      break;
    case "session.error":
      ctx.log.warn("S2S << session.error", {
        ...sidFields(ctx),
        code: msg.code,
        message: msg.message,
      });
      if (msg.code === "session_not_found" || msg.code === "session_forbidden") {
        callbacks.onSessionExpired();
      } else {
        callbacks.onError(new Error(msg.message));
      }
      break;
    case "error":
      // Logged here with its message because `logIncoming` prints the type
      // only, and the transport now forwards in-band errors as NON-fatal (see
      // its `onError` mapping) — which session-core logs at debug. Without this
      // line, demoting the client-facing severity would also have made the
      // service's own complaint invisible in a default-logger deployment.
      ctx.log.warn("S2S << error", { ...sidFields(ctx), message: msg.message });
      callbacks.onError(new Error(msg.message));
      break;
    default:
      break;
  }
}

export type S2sSessionConfig = {
  systemPrompt: string;
  tools: ToolSchema[];
  greeting?: string;
};

/** Callbacks fired into the owning session at construction time. */
export type S2sCallbacks = {
  onSessionReady(sessionId: string): void;
  onReplyStarted(replyId: string): void;
  onReplyDone(): void;
  onCancelled(): void;
  onAudio(bytes: Uint8Array): void;
  onUserTranscript(text: string): void;
  /** Live partial of the user's current utterance; replaces, never appends. */
  onUserTranscriptPartial(text: string): void;
  onAgentTranscript(text: string, interrupted: boolean): void;
  onToolCall(callId: string, name: string, args: Record<string, unknown>): void;
  onSpeechStarted(): void;
  onSpeechStopped(): void;
  onSessionExpired(): void;
  onError(err: Error): void;
  onClose(code: number, reason: string): void;
};

export type S2sHandle = {
  sendAudio(audio: Uint8Array): void;
  /**
   * Send a tool result. Returns whether the frame actually went out — false
   * means the socket was not open (e.g. dropped, awaiting resume), and the
   * provider session is still waiting on this result: the caller must queue
   * it for redelivery or the provider-side turn stalls.
   */
  sendToolResult(callId: string, result: string): boolean;
  updateSession(config: S2sSessionConfig): void;
  resumeSession(sessionId: string): void;
  close(): void;
};

export type ConnectS2sOptions = {
  apiKey: string;
  config: S2SConfig;
  createWebSocket: CreateS2sWebSocket;
  callbacks: S2sCallbacks;
  logger?: Logger;
  /**
   * Session id attached to diagnostic log lines (e.g. raw `reply.done`
   * arrivals from the S2S service). Optional; logs omit the field when
   * not provided.
   */
  sid?: string;
  /**
   * Abandons a handshake that has not completed yet — the caller's teardown.
   * Without it a socket stuck between `connect` and `open` can never be closed
   * by anyone: this function only returns a handle once the socket opens, so
   * there is nothing for the caller to close, and `ws` sets no
   * `handshakeTimeout`, so nothing times it out either. A client that hangs up
   * mid-resume then leaves a half-open (billed) provider connection pinned for
   * the life of the process.
   */
  signal?: AbortSignal;
};

export async function connectS2s(opts: ConnectS2sOptions): Promise<S2sHandle> {
  const { apiKey, config, createWebSocket, callbacks, logger: log = consoleLogger, sid } = opts;

  // Already abandoned: never open a socket the caller has no use for.
  opts.signal?.throwIfAborted();

  log.info("S2S connecting", { url: config.wssUrl });

  const ws = createWebSocket(config.wssUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  // Drop mic frames while the provider link is stalled (audio is
  // loss-tolerant; a stalled socket must not queue live speech unboundedly).
  // Only sendAudio is gated — control messages always go through.
  const audioGate = createAudioSendGate({
    bufferedAmount: () => ws.bufferedAmount,
    label: "S2S",
    log,
  });

  const dispatchState: DispatchState = {
    speechActive: false,
    reply: createReplyAudit(),
  };
  const dispatchCtx: DispatchContext = sid !== undefined ? { log, sid } : { log };
  // Handlers below stay registered for the socket's whole life; the race routes
  // pre-open failures to the connect and later ones to the session callbacks.
  const connect = createWsOpenRace();

  // Abandon an unfinished handshake (see `signal` above). Once the socket has
  // opened this is a no-op: the caller holds the handle by then and closes it
  // through the normal teardown, which is also what keeps this from racing a
  // session that is already live.
  opts.signal?.addEventListener(
    "abort",
    () => {
      if (!connect.isOpening()) return;
      log.info("S2S connect abandoned before open", { url: config.wssUrl });
      ws.close(WS_NORMAL_CLOSURE);
      connect.fail(new Error("S2S connect abandoned before open"));
    },
    { once: true },
  );

  function send(msg: { type: string; [key: string]: unknown }): boolean {
    if (ws.readyState !== WS_OPEN) {
      log.debug("S2S send dropped: socket not open", { type: msg.type });
      return false;
    }
    const json = JSON.stringify(msg);
    // Per-outbound-message logging is a hot path (one line per wire
    // message); debug-only so the default logger pays nothing.
    if (msg.type === "session.update") {
      log.debug(`S2S >> ${msg.type}`, { payload: json });
    } else if (msg.type !== "input.audio") {
      log.debug(`S2S >> ${msg.type}`);
    }
    ws.send(json);
    return true;
  }

  const handle: S2sHandle = {
    sendAudio(audio: Uint8Array): void {
      if (ws.readyState !== WS_OPEN || audioGate.shouldDrop()) return;
      ws.send(`{"type":"input.audio","audio":"${uint8ToBase64(audio)}"}`);
    },

    sendToolResult(callId: string, result: string): boolean {
      log.info("S2S >> tool.result", { call_id: callId, resultLength: result.length });
      return send({ type: "tool.result", call_id: callId, result });
    },

    updateSession(sessionConfig: S2sSessionConfig): void {
      const { systemPrompt, ...rest } = sessionConfig;
      send({ type: "session.update", session: { system_prompt: systemPrompt, ...rest } });
    },

    resumeSession(sessionId: string): void {
      send({ type: "session.resume", session_id: sessionId });
    },

    close(): void {
      log.info("S2S closing");
      // Explicitly Normal Closure. `close()` with no code sends a statusless
      // frame, which both ends then report as 1005 "No Status Received" —
      // indistinguishable in the logs from the peer dropping us, and 1005 is
      // in the transport's TRANSIENT_CLOSE_CODES, so our own teardown would
      // look like something worth resuming.
      ws.close(WS_NORMAL_CLOSURE);
    },
  };

  ws.addEventListener("open", () => {
    log.info("S2S WebSocket open");
    connect.markOpen();
  });

  function logIncoming(type: unknown): void {
    // reply.audio and input.audio are ~95% of traffic — skip logging.
    // reply.done and session.error get richer logs inside dispatch;
    // skip here to avoid a duplicate line.
    if (
      type === "reply.audio" ||
      type === "input.audio" ||
      type === "reply.done" ||
      type === "session.error"
    ) {
      return;
    }
    log.info(`S2S << ${type}`);
  }

  function handleObject(obj: Record<string, unknown>, raw: unknown): void {
    logIncoming(obj.type);
    // Log the full tool.call payload so we can diagnose provider-side
    // empty-args problems — the underlying LLM emitting a function call
    // without populating its required parameters. Without the full
    // payload we cannot tell apart "field-name mismatch" from
    // "model emitted no args." Guarded by the process-wide debug flag
    // (AAI_DEBUG=1) so the stringify itself is skipped when debug is off.
    if (debugLoggingEnabled && obj.type === "tool.call") {
      log.debug("S2S << tool.call payload", { payload: JSON.stringify(obj) });
    }
    if (obj.type === "reply.audio" && typeof obj.data === "string") {
      const bytes = base64ToUint8(obj.data);
      countReplyAudio(dispatchState.reply, bytes.length);
      callbacks.onAudio(bytes);
      return;
    }
    const parsed = parseS2sMessage(obj);
    if (!parsed) {
      log.warn(
        `S2S << unrecognised message type: ${obj.type ?? JSON.stringify(raw).slice(0, LOG_PREVIEW_CHARS)}`,
      );
      return;
    }
    dispatchS2sMessage(callbacks, parsed, dispatchState, dispatchCtx);
  }

  ws.addEventListener("message", (ev) => {
    // The dispatch below fans out into session/tool code; a throw escaping a
    // ws 'message' handler would be an uncaughtException that takes down the
    // host — surface it through the session error path instead.
    try {
      const raw = safeJsonParse(String(ev.data));
      if (raw === undefined) {
        log.warn("S2S << invalid JSON", { data: String(ev.data).slice(0, LOG_PREVIEW_CHARS) });
        return;
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        log.warn("S2S << non-object JSON message", { type: typeof raw });
        return;
      }
      handleObject(raw as Record<string, unknown>, raw);
    } catch (err) {
      const msg = errorMessage(err);
      log.error("S2S message dispatch failed", { error: msg });
      callbacks.onError(new Error(`S2S message dispatch failed: ${msg}`));
    }
  });

  // Message from a post-open socket `error`, held for the `close` handler.
  // The `ws` library always follows a fatal socket error with `close`, and
  // the close path is where the transport decides between resuming and
  // failing the session — so the error is folded into that decision instead
  // of surfaced on its own. Reporting it immediately sent the client a
  // fatal-looking `error` frame for the most common transient-drop shape
  // (error-then-close), tearing the client down moments before the resume
  // machinery successfully restored a session nobody was listening to.
  let lastSocketError: string | null = null;

  ws.addEventListener("close", (ev) => {
    const code = ev.code ?? 0;
    const reason = ev.reason || (lastSocketError ?? "");
    log.info("S2S WebSocket closed", { code, reason });
    if (connect.isOpening()) {
      connect.fail(new Error(`WebSocket closed before open (code: ${code})`));
    }
    callbacks.onClose(code, reason);
  });

  ws.addEventListener("error", (ev) => {
    const message = typeof ev.message === "string" ? ev.message : "WebSocket error";
    const errObj = new Error(message);
    log.error("S2S WebSocket error", { error: errObj.message });
    if (connect.isOpening()) {
      connect.fail(errObj);
    } else {
      // Deferred to the close handler — see lastSocketError above.
      lastSocketError = message;
    }
  });

  await connect.promise;
  return handle;
}
