// Copyright 2025 the AAI authors. MIT license.
/**
 * Speech-to-Speech WebSocket client for AssemblyAI's S2S API.
 */

import type { JSONSchema7 } from "json-schema";
import { createNanoEvents, type Emitter, type Unsubscribe } from "nanoevents";
import { WebSocket } from "ws";
import { z } from "zod";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";
import { s2sConnectionDuration, s2sErrorCounter, tracer } from "./telemetry.ts";

const uint8ToBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const base64ToUint8 = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, "base64"));

export type S2sWebSocket = {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(): void;
  ping?(): void;
  addEventListener(type: "open" | "pong", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: must accept any listener signature for cleanup
  removeEventListener(type: string, listener: (...args: any[]) => void): void;
};

const WS_OPEN = 1;

export type CreateS2sWebSocket = (
  url: string,
  opts: { headers: Record<string, string> },
) => S2sWebSocket;

export const defaultCreateS2sWebSocket: CreateS2sWebSocket = (url, opts) =>
  new WebSocket(url, { headers: opts.headers });

const S2sServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.ready"), session_id: z.string() }),
  z.object({ type: z.literal("session.updated") }).passthrough(),
  z.object({ type: z.literal("input.speech.started") }),
  z.object({ type: z.literal("input.speech.stopped") }),
  z.object({ type: z.literal("transcript.user.delta"), text: z.string() }),
  z.object({
    type: z.literal("transcript.user"),
    item_id: z.string(),
    text: z.string(),
  }),
  z.object({ type: z.literal("reply.started"), reply_id: z.string() }),
  // reply.audio is handled on the fast path before Zod.
  z.object({ type: z.literal("transcript.agent.delta"), delta: z.string() }).passthrough(),
  z.object({ type: z.literal("transcript.agent"), text: z.string() }),
  z.object({ type: z.literal("reply.content_part.started") }).passthrough(),
  z.object({ type: z.literal("reply.content_part.done") }).passthrough(),
  z.object({
    type: z.literal("tool.call"),
    call_id: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()).optional().default({}),
  }),
  z.object({
    type: z.literal("reply.done"),
    status: z.string().optional(),
  }),
  z.object({
    type: z.literal("session.error"),
    code: z.string(),
    message: z.string(),
  }),
  // Connection-level error (bare "error" without "session." prefix).
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);

type S2sServerMessage = z.infer<typeof S2sServerMessageSchema>;

function dispatchS2sMessage(emitter: Emitter<S2sEvents>, msg: S2sServerMessage): void {
  switch (msg.type) {
    case "session.ready":
      emitter.emit("ready", { session_id: msg.session_id });
      break;
    case "session.updated":
      emitter.emit("session_updated", msg);
      break;
    case "input.speech.started":
      emitter.emit("speech_started");
      break;
    case "input.speech.stopped":
      emitter.emit("speech_stopped");
      break;
    case "transcript.user.delta":
      emitter.emit("user_transcript_delta", { text: msg.text });
      break;
    case "transcript.user":
      emitter.emit("user_transcript", { item_id: msg.item_id, text: msg.text });
      break;
    case "reply.started":
      emitter.emit("reply_started", { reply_id: msg.reply_id });
      break;
    case "transcript.agent.delta":
      emitter.emit("agent_transcript_delta", { text: msg.delta });
      break;
    case "transcript.agent":
      emitter.emit("agent_transcript", { text: msg.text });
      break;
    case "tool.call":
      emitter.emit("tool_call", { call_id: msg.call_id, name: msg.name, args: msg.args });
      break;
    case "reply.done":
      emitter.emit("reply_done", msg.status ? { status: msg.status } : {});
      break;
    case "session.error":
      if (msg.code === "session_not_found" || msg.code === "session_forbidden")
        emitter.emit("session_expired", { code: msg.code, message: msg.message });
      else emitter.emit("error", { code: msg.code, message: msg.message });
      break;
    case "error":
      emitter.emit("error", { code: "connection", message: msg.message });
      break;
    case "reply.content_part.started":
    case "reply.content_part.done":
      break;
    default:
      break;
  }
}

export type S2sSessionConfig = {
  system_prompt: string;
  tools: S2sToolSchema[];
  greeting?: string;
};
export type S2sToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: JSONSchema7;
};
export type S2sToolCall = {
  call_id: string;
  name: string;
  args: Record<string, unknown>;
};
export type S2sEvents = {
  ready: (detail: { session_id: string }) => void;
  session_updated: (detail: Record<string, unknown>) => void;
  session_expired: (detail: { code: string; message: string }) => void;
  speech_started: () => void;
  speech_stopped: () => void;
  user_transcript_delta: (detail: { text: string }) => void;
  user_transcript: (detail: { item_id: string; text: string }) => void;
  reply_started: (detail: { reply_id: string }) => void;
  agent_transcript_delta: (detail: { text: string }) => void;
  agent_transcript: (detail: { text: string }) => void;
  tool_call: (detail: S2sToolCall) => void;
  reply_done: (detail: { status?: string }) => void;
  audio: (detail: { audio: Uint8Array }) => void;
  error: (detail: { code: string; message: string }) => void;
  close: () => void;
};

export type S2sHandle = {
  on<K extends keyof S2sEvents>(event: K, cb: S2sEvents[K]): Unsubscribe;
  sendAudio(audio: Uint8Array): void;
  sendToolResult(callId: string, result: string): void;
  updateSession(config: S2sSessionConfig): void;
  resumeSession(sessionId: string): void;
  close(): void;
};

export type ConnectS2sOptions = {
  apiKey: string;
  config: S2SConfig;
  createWebSocket: CreateS2sWebSocket;
  logger?: Logger;
};

const S2S_CONNECT_TIMEOUT_MS = 10_000;
const S2S_PING_INTERVAL_MS = 30_000;
const S2S_PONG_TIMEOUT_MS = 10_000;
const S2S_BACKPRESSURE_THRESHOLD = 256 * 1024;

type HeartbeatState = {
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
};
function startS2sHeartbeat(ws: S2sWebSocket, log: Logger, hb: HeartbeatState): void {
  const pingFn = ws.ping;
  if (typeof pingFn !== "function") return;
  hb.pingTimer = setInterval(() => {
    if (ws.readyState !== WS_OPEN) {
      clearS2sHeartbeat(hb);
      return;
    }
    pingFn.call(ws);
    hb.pongTimer = setTimeout(() => {
      log.warn("S2S pong timeout — closing connection");
      ws.close();
    }, S2S_PONG_TIMEOUT_MS);
  }, S2S_PING_INTERVAL_MS);
}
function clearS2sHeartbeat(hb: HeartbeatState): void {
  if (hb.pingTimer) clearInterval(hb.pingTimer);
  if (hb.pongTimer) clearTimeout(hb.pongTimer);
  hb.pingTimer = null;
  hb.pongTimer = null;
}
function dispatchRawS2sMessage(data: unknown, emitter: Emitter<S2sEvents>, log: Logger): void {
  let raw: unknown;
  try {
    raw = JSON.parse(String(data));
  } catch {
    log.warn("S2S << invalid JSON", { data: String(data).slice(0, 200) });
    return;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    log.warn("S2S << non-object JSON message", { type: typeof raw });
    return;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.type !== "reply.audio" && obj.type !== "input.audio") {
    log.info(
      `S2S << ${obj.type}`,
      obj.type === "transcript.agent.delta" ? { delta: obj.delta } : undefined,
    );
  }
  if (obj.type === "reply.audio" && typeof obj.data === "string") {
    emitter.emit("audio", { audio: base64ToUint8(obj.data) });
    return;
  }
  const parsed = S2sServerMessageSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn(`S2S << unrecognised message type: ${obj.type ?? JSON.stringify(raw).slice(0, 200)}`);
    return;
  }
  dispatchS2sMessage(emitter, parsed.data);
}
/** Connect to AssemblyAI's S2S WebSocket API. Returns an {@link S2sHandle}. */
export function connectS2s(opts: ConnectS2sOptions): Promise<S2sHandle> {
  const { apiKey, config, createWebSocket, logger: log = consoleLogger } = opts;

  return new Promise((resolve, reject) => {
    log.info("S2S connecting", { url: config.wssUrl });

    const connectionSpan = tracer.startSpan("s2s.connection", {
      attributes: { "aai.s2s.url": config.wssUrl },
    });
    const connectStart = performance.now();

    const ws = createWebSocket(config.wssUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const emitter = createNanoEvents<S2sEvents>();
    let opened = false;
    const hb: HeartbeatState = { pingTimer: null, pongTimer: null };

    // Connection timeout — reject if open event not received in time.
    const connectTimer = setTimeout(() => {
      if (!opened) {
        const err = new Error(`S2S connection timed out after ${S2S_CONNECT_TIMEOUT_MS}ms`);
        log.error("S2S connection timeout", { url: config.wssUrl });
        s2sErrorCounter.add(1);
        connectionSpan.setStatus({ code: 2, message: err.message });
        connectionSpan.recordException(err);
        connectionSpan.end();
        ws.close();
        reject(err);
      }
    }, S2S_CONNECT_TIMEOUT_MS);

    ws.addEventListener("pong", () => {
      if (hb.pongTimer) {
        clearTimeout(hb.pongTimer);
        hb.pongTimer = null;
      }
    });

    function send(msg: { type: string; [key: string]: unknown }): void {
      if (ws.readyState !== WS_OPEN) return;
      const json = JSON.stringify(msg);
      if (msg.type !== "input.audio") {
        log.info(
          `S2S >> ${msg.type}`,
          msg.type === "session.update" ? { payload: json } : undefined,
        );
      }
      ws.send(json);
    }

    const handle: S2sHandle = {
      on: emitter.on.bind(emitter),

      sendAudio(audio: Uint8Array): void {
        if (ws.readyState !== WS_OPEN) return;
        // Drop audio frames when the send buffer is congested
        // to prevent unbounded memory growth during network hiccups.
        if (
          typeof ws.bufferedAmount === "number" &&
          ws.bufferedAmount > S2S_BACKPRESSURE_THRESHOLD
        ) {
          return;
        }
        ws.send(`{"type":"input.audio","audio":"${uint8ToBase64(audio)}"}`);
      },

      sendToolResult(callId: string, result: string): void {
        const msg = { type: "tool.result", call_id: callId, result };
        log.info("S2S >> tool.result", { call_id: callId, resultLength: result.length });
        send(msg);
      },

      updateSession(sessionConfig: S2sSessionConfig): void {
        send({ type: "session.update", session: sessionConfig });
      },

      resumeSession(sessionId: string): void {
        send({ type: "session.resume", session_id: sessionId });
      },

      close(): void {
        log.info("S2S closing");
        clearS2sHeartbeat(hb);
        removeListeners();
        ws.close();
      },
    };

    const handleS2sMessage = (ev: { data: unknown }) =>
      dispatchRawS2sMessage(ev.data, emitter, log);

    function handleOpen(): void {
      opened = true;
      clearTimeout(connectTimer);
      log.info("S2S WebSocket open");
      connectionSpan.addEvent("ws.open");
      startS2sHeartbeat(ws, log, hb);
      resolve(handle);
    }

    function handleClose(ev: { code?: number; reason?: string }): void {
      clearTimeout(connectTimer);
      clearS2sHeartbeat(hb);
      log.info("S2S WebSocket closed", {
        code: ev.code ?? 0,
        reason: ev.reason ?? "",
      });
      const elapsed = (performance.now() - connectStart) / 1000;
      s2sConnectionDuration.record(elapsed);
      connectionSpan.addEvent("ws.closed", {
        "ws.close.code": ev.code ?? 0,
        "ws.close.reason": ev.reason ?? "",
      });
      connectionSpan.end();
      removeListeners();
      if (!opened) {
        reject(new Error(`WebSocket closed before open (code: ${ev.code ?? 0})`));
      }
      emitter.emit("close");
    }

    function handleError(ev: { message?: string }): void {
      clearTimeout(connectTimer);
      clearS2sHeartbeat(hb);
      const message = typeof ev.message === "string" ? ev.message : "WebSocket error";
      const errObj = new Error(message);
      log.error("S2S WebSocket error", { error: errObj.message });
      s2sErrorCounter.add(1);
      connectionSpan.setStatus({ code: 2, message: errObj.message }); // ERROR
      connectionSpan.recordException(errObj);
      if (!opened) {
        removeListeners();
        connectionSpan.end();
        reject(errObj);
      } else {
        emitter.emit("error", { code: "ws_error", message: errObj.message });
      }
    }

    function removeListeners(): void {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("message", handleS2sMessage);
      ws.removeEventListener("close", handleClose);
      ws.removeEventListener("error", handleError);
    }

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("message", handleS2sMessage);
    ws.addEventListener("close", handleClose);
    ws.addEventListener("error", handleError);
  });
}
