// Copyright 2025 the AAI authors. MIT license.
/**
 * Speech-to-Speech WebSocket client for AssemblyAI's S2S API.
 */

import type { JSONSchema7 } from "json-schema";
import WsWebSocket from "ws";
import { z } from "zod";
import { WS_OPEN } from "../sdk/constants.ts";
import type { ClientEvent } from "../sdk/protocol.ts";
import { base64ToUint8, uint8ToBase64 } from "./_base64.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";

export type S2sWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
};

export type CreateS2sWebSocket = (
  url: string,
  opts: { headers: Record<string, string> },
) => S2sWebSocket;

// Node's native WebSocket doesn't support custom headers; the `ws` package does.
export const defaultCreateS2sWebSocket: CreateS2sWebSocket = (url, opts) =>
  new WsWebSocket(url, { headers: opts.headers }) as unknown as S2sWebSocket;

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
  z.object({ type: z.literal("reply.started"), reply_id: z.string() }),
  z.object({
    type: z.literal("transcript.agent"),
    text: z.string(),
    reply_id: z.string().optional().default(""),
    item_id: z.string().optional().default(""),
    interrupted: z.boolean().optional().default(false),
  }),
  z.object({
    type: z.literal("tool.call"),
    call_id: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()).optional().default({}),
  }),
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
 * A ClientEvent extended with optional internal metadata for S2S-specific
 * fields that don't appear on the wire protocol (e.g. `interrupted` on
 * `agent_transcript`, which affects conversation history but not the client).
 */
export type S2sEvent = ClientEvent & { _interrupted?: boolean };

/**
 * Per-connection dispatch state. Used to dedup events that the upstream S2S
 * service may emit more than once for a single logical turn (e.g. repeated
 * `input.speech.stopped` after the VAD flips).
 */
type DispatchState = { speechActive: boolean };

type DispatchContext = {
  log: Logger;
  sid?: string;
};

function sidFields(ctx: DispatchContext): { sid?: string } {
  return ctx.sid !== undefined ? { sid: ctx.sid } : {};
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
    case "reply.started":
      callbacks.onReplyStarted(msg.reply_id);
      break;
    case "transcript.agent":
      callbacks.onAgentTranscript(msg.text, msg.interrupted);
      break;
    case "tool.call":
      callbacks.onToolCall(msg.call_id, msg.name, msg.args);
      break;
    case "reply.done":
      // Log every raw reply.done before client-facing dedup so we can
      // cross-check which stalled sessions actually got one.
      ctx.log.info("S2S << reply.done", {
        ...sidFields(ctx),
        status: msg.status ?? "completed",
      });
      if (msg.status === "interrupted") callbacks.onCancelled();
      else callbacks.onReplyDone();
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
      callbacks.onError(new Error(msg.message));
      break;
    default:
      break;
  }
}

export type S2sSessionConfig = {
  systemPrompt: string;
  tools: S2sToolSchema[];
  greeting?: string;
};

export type S2sToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: JSONSchema7;
};

/** Callbacks fired into the owning session at construction time. */
export type S2sCallbacks = {
  onSessionReady(sessionId: string): void;
  onReplyStarted(replyId: string): void;
  onReplyDone(): void;
  onCancelled(): void;
  onAudio(bytes: Uint8Array): void;
  onUserTranscript(text: string): void;
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
   * Send a pre-encoded audio wire frame. For perf-critical callers (load tests)
   * that batch-encode up front. Skips logging; caller owns wire format.
   */
  sendAudioRaw(jsonFrame: string): void;
  sendToolResult(callId: string, result: string): void;
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
};

export function connectS2s(opts: ConnectS2sOptions): Promise<S2sHandle> {
  const { apiKey, config, createWebSocket, callbacks, logger: log = consoleLogger, sid } = opts;

  return new Promise((resolve, reject) => {
    log.info("S2S connecting", { url: config.wssUrl });

    const ws = createWebSocket(config.wssUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const dispatchState: DispatchState = { speechActive: false };
    const dispatchCtx: DispatchContext = sid !== undefined ? { log, sid } : { log };
    let opened = false;

    function send(msg: { type: string; [key: string]: unknown }): void {
      if (ws.readyState !== WS_OPEN) {
        log.debug("S2S send dropped: socket not open", { type: msg.type });
        return;
      }
      const json = JSON.stringify(msg);
      if (msg.type === "session.update") {
        log.info(`S2S >> ${msg.type}`, { payload: json });
      } else if (msg.type !== "input.audio") {
        log.info(`S2S >> ${msg.type}`);
      }
      ws.send(json);
    }

    const handle: S2sHandle = {
      sendAudio(audio: Uint8Array): void {
        if (ws.readyState !== WS_OPEN) return;
        ws.send(`{"type":"input.audio","audio":"${uint8ToBase64(audio)}"}`);
      },

      sendAudioRaw(jsonFrame: string): void {
        if (ws.readyState !== WS_OPEN) return;
        ws.send(jsonFrame);
      },

      sendToolResult(callId: string, result: string): void {
        log.info("S2S >> tool.result", { call_id: callId, resultLength: result.length });
        send({ type: "tool.result", call_id: callId, result });
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
        ws.close();
      },
    };

    ws.addEventListener("open", () => {
      opened = true;
      log.info("S2S WebSocket open");
      resolve(handle);
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

    ws.addEventListener("message", (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch {
        log.warn("S2S << invalid JSON", { data: String(ev.data).slice(0, 200) });
        return;
      }

      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        log.warn("S2S << non-object JSON message", { type: typeof raw });
        return;
      }
      const obj = raw as Record<string, unknown>;
      logIncoming(obj.type);

      if (obj.type === "reply.audio" && typeof obj.data === "string") {
        callbacks.onAudio(base64ToUint8(obj.data));
        return;
      }

      const parsed = parseS2sMessage(obj);
      if (!parsed) {
        log.warn(
          `S2S << unrecognised message type: ${obj.type ?? JSON.stringify(raw).slice(0, 200)}`,
        );
        return;
      }
      dispatchS2sMessage(callbacks, parsed, dispatchState, dispatchCtx);
    });

    ws.addEventListener("close", (ev) => {
      const code = ev.code ?? 0;
      const reason = ev.reason ?? "";
      log.info("S2S WebSocket closed", { code, reason });
      if (!opened) {
        reject(new Error(`WebSocket closed before open (code: ${code})`));
      }
      callbacks.onClose(code, reason);
    });

    ws.addEventListener("error", (ev) => {
      const message = typeof ev.message === "string" ? ev.message : "WebSocket error";
      const errObj = new Error(message);
      log.error("S2S WebSocket error", { error: errObj.message });
      if (!opened) {
        reject(errObj);
      } else {
        callbacks.onError(errObj);
      }
    });
  });
}
