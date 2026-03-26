// Copyright 2025 the AAI authors. MIT license.
/**
 * Speech-to-Speech WebSocket client for AssemblyAI's S2S API.
 */

import type { JSONSchema7 } from "json-schema";
import { createNanoEvents, type Emitter, type Unsubscribe } from "nanoevents";
import { WebSocket } from "ws";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";
import { s2sConnectionDuration, s2sErrorCounter, tracer } from "./telemetry.ts";

const uint8ToBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const base64ToUint8 = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, "base64"));

// ─── WebSocket abstraction ──────────────────────────────────────────────────

/** Minimal WebSocket interface for the S2S client. */
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

/** WebSocket readyState constant for OPEN. */
const WS_OPEN = 1;

/** Factory for creating WebSocket connections (e.g. the `ws` package). */
export type CreateS2sWebSocket = (
  url: string,
  opts: { headers: Record<string, string> },
) => S2sWebSocket;

/** Default S2S WebSocket factory using the `ws` package (Node-only). */
export const defaultCreateS2sWebSocket: CreateS2sWebSocket = (url, opts) =>
  new WebSocket(url, { headers: opts.headers });

// ─── Incoming S2S message types ──────────────────────────────────────────────

type S2sServerMessage =
  | { type: "session.ready"; session_id: string }
  | { type: "session.updated"; [k: string]: unknown }
  | { type: "input.speech.started" }
  | { type: "input.speech.stopped" }
  | { type: "transcript.user.delta"; text: string }
  | { type: "transcript.user"; item_id: string; text: string }
  | { type: "reply.started"; reply_id: string }
  | { type: "transcript.agent.delta"; delta: string; [k: string]: unknown }
  | { type: "transcript.agent"; text: string }
  | { type: "reply.content_part.started"; [k: string]: unknown }
  | { type: "reply.content_part.done"; [k: string]: unknown }
  | { type: "tool.call"; call_id: string; name: string; args: Record<string, unknown> }
  | { type: "reply.done"; status?: string }
  | { type: "session.error"; code: string; message: string }
  | { type: "error"; message: string };

/** Check that `obj` has string-typed fields for each key. */
function hasStringFields(obj: Record<string, unknown>, ...keys: string[]): boolean {
  for (const k of keys) if (typeof obj[k] !== "string") return false;
  return true;
}

function parseToolCall(obj: Record<string, unknown>): S2sServerMessage | undefined {
  if (!hasStringFields(obj, "call_id", "name")) return;
  const callId = obj.call_id;
  const name = obj.name;
  if (typeof callId !== "string" || typeof name !== "string") return;
  const args =
    obj.args != null && typeof obj.args === "object" && !Array.isArray(obj.args)
      ? (obj.args as Record<string, unknown>)
      : {};
  return { type: "tool.call", call_id: callId, name, args };
}

type MessageValidator = (obj: Record<string, unknown>) => S2sServerMessage | undefined;

function passthrough(obj: Record<string, unknown>): S2sServerMessage {
  return obj as S2sServerMessage;
}

function requireFields(
  ...keys: string[]
): (obj: Record<string, unknown>) => S2sServerMessage | undefined {
  return (obj) => (hasStringFields(obj, ...keys) ? (obj as S2sServerMessage) : undefined);
}

/** Lookup table mapping S2S message types to their validators. */
const MESSAGE_VALIDATORS = new Map<string, MessageValidator>([
  ["session.ready", requireFields("session_id")],
  ["session.updated", passthrough],
  ["input.speech.started", passthrough],
  ["input.speech.stopped", passthrough],
  ["reply.content_part.started", passthrough],
  ["reply.content_part.done", passthrough],
  ["transcript.user.delta", requireFields("text")],
  ["transcript.user", requireFields("item_id", "text")],
  ["reply.started", requireFields("reply_id")],
  ["transcript.agent.delta", requireFields("delta")],
  ["transcript.agent", requireFields("text")],
  ["tool.call", parseToolCall],
  [
    "reply.done",
    (obj) => ({
      type: "reply.done" as const,
      ...(typeof obj.status === "string" ? { status: obj.status } : {}),
    }),
  ],
  ["session.error", requireFields("code", "message")],
  ["error", requireFields("message")],
]);

/**
 * Manually parse an S2S server message from a raw JSON object, avoiding
 * Zod schema overhead on the hot path. Returns undefined for unrecognised types.
 */
function parseS2sMessage(obj: Record<string, unknown>): S2sServerMessage | undefined {
  const type = obj.type;
  if (typeof type !== "string") return;
  return MESSAGE_VALIDATORS.get(type)?.(obj);
}

/** Dispatch a parsed S2S server message to the emitter, mapping wire-format
 *  snake_case fields to SDK-facing camelCase at the boundary. */
function dispatchS2sMessage(emitter: Emitter<S2sEvents>, msg: S2sServerMessage): void {
  switch (msg.type) {
    case "session.ready":
      emitter.emit("ready", { sessionId: msg.session_id });
      break;
    case "session.updated":
      emitter.emit("sessionUpdated", msg);
      break;
    case "input.speech.started":
      emitter.emit("speechStarted");
      break;
    case "input.speech.stopped":
      emitter.emit("speechStopped");
      break;
    case "transcript.user.delta":
      emitter.emit("userTranscriptDelta", { text: msg.text });
      break;
    case "transcript.user":
      emitter.emit("userTranscript", { itemId: msg.item_id, text: msg.text });
      break;
    case "reply.started":
      emitter.emit("replyStarted", { replyId: msg.reply_id });
      break;
    case "transcript.agent.delta":
      emitter.emit("agentTranscriptDelta", { text: msg.delta });
      break;
    case "transcript.agent":
      emitter.emit("agentTranscript", { text: msg.text });
      break;
    case "tool.call":
      emitter.emit("toolCall", { callId: msg.call_id, name: msg.name, args: msg.args });
      break;
    case "reply.done":
      emitter.emit("replyDone", msg.status ? { status: msg.status } : {});
      break;
    case "session.error":
      if (msg.code === "session_not_found" || msg.code === "session_forbidden")
        emitter.emit("sessionExpired", { code: msg.code, message: msg.message });
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

// ─── Types ──────────────────────────────────────────────────────────────────

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

export type S2sToolCall = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

/** Typed event map for S2S handle events. */
export type S2sEvents = {
  ready: (detail: { sessionId: string }) => void;
  sessionUpdated: (detail: Record<string, unknown>) => void;
  sessionExpired: (detail: { code: string; message: string }) => void;
  speechStarted: () => void;
  speechStopped: () => void;
  userTranscriptDelta: (detail: { text: string }) => void;
  userTranscript: (detail: { itemId: string; text: string }) => void;
  replyStarted: (detail: { replyId: string }) => void;
  agentTranscriptDelta: (detail: { text: string }) => void;
  agentTranscript: (detail: { text: string }) => void;
  toolCall: (detail: S2sToolCall) => void;
  replyDone: (detail: { status?: string }) => void;
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

// ─── Connect ────────────────────────────────────────────────────────────────

export type ConnectS2sOptions = {
  apiKey: string;
  config: S2SConfig;
  createWebSocket: CreateS2sWebSocket;
  logger?: Logger;
};

/**
 * Connect to AssemblyAI's Speech-to-Speech WebSocket API.
 *
 * Returns an {@link S2sHandle} with a typed `on()` method.
 * Consumers listen for events: `ready`, `speechStarted`, `speechStopped`,
 * `userTranscriptDelta`, `userTranscript`, `replyStarted`,
 * `replyDone`, `audio`, `agentTranscript`, `toolCall`,
 * `sessionExpired`, `error`, `close`.
 */
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

    function send(msg: { type: string; [key: string]: unknown }): void {
      if (ws.readyState !== WS_OPEN) {
        log.debug("S2S send dropped: socket not open", { type: msg.type });
        return;
      }
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
        if (ws.readyState !== WS_OPEN) {
          log.debug("S2S sendAudio dropped: socket not open");
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
      connectionSpan.addEvent("ws.open");
      resolve(handle);
    });

    function tryParseJson(data: unknown): unknown | undefined {
      try {
        return JSON.parse(String(data));
      } catch {
        log.warn("S2S << invalid JSON", { data: String(data).slice(0, 200) });
      }
    }

    function handleAudioFastPath(obj: { type?: unknown; data?: unknown }): boolean {
      if (obj.type === "reply.audio" && typeof obj.data === "string") {
        const audioBytes = base64ToUint8(obj.data);
        emitter.emit("audio", { audio: audioBytes });
        return true;
      }
      return false;
    }

    function logIncoming(obj: { type?: unknown; delta?: unknown }): void {
      // reply.audio and input.audio are ~95% of traffic — skip logging.
      if (obj.type === "reply.audio" || obj.type === "input.audio") return;
      log.info(
        `S2S << ${obj.type}`,
        obj.type === "transcript.agent.delta" ? { delta: obj.delta } : undefined,
      );
    }

    function handleS2sMessage(ev: { data: unknown }): void {
      const raw = tryParseJson(ev.data);
      if (raw === undefined) return;

      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        log.warn("S2S << non-object JSON message", { type: typeof raw });
        return;
      }
      const obj = raw as Record<string, unknown>;
      logIncoming(obj);
      if (handleAudioFastPath(obj)) return;

      const parsed = parseS2sMessage(obj);
      if (!parsed) {
        log.warn(
          `S2S << unrecognised message type: ${obj.type ?? JSON.stringify(raw).slice(0, 200)}`,
        );
        return;
      }
      dispatchS2sMessage(emitter, parsed);
    }

    ws.addEventListener("message", handleS2sMessage);

    ws.addEventListener("close", (ev) => {
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
      if (!opened) {
        reject(new Error(`WebSocket closed before open (code: ${ev.code ?? 0})`));
      }
      emitter.emit("close");
    });

    ws.addEventListener("error", (ev) => {
      const message = typeof ev.message === "string" ? ev.message : "WebSocket error";
      const errObj = new Error(message);
      log.error("S2S WebSocket error", { error: errObj.message });
      s2sErrorCounter.add(1);
      connectionSpan.setStatus({ code: 2, message: errObj.message }); // ERROR
      connectionSpan.recordException(errObj);
      if (!opened) {
        connectionSpan.end();
        reject(errObj);
      } else {
        emitter.emit("error", { code: "ws_error", message: errObj.message });
      }
    });
  });
}
