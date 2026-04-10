// Copyright 2025 the AAI authors. MIT license.
/**
 * Speech-to-Speech WebSocket client for AssemblyAI's S2S API.
 */

import type { JSONSchema7 } from "json-schema";
import { createNanoEvents, type Emitter, type Unsubscribe } from "nanoevents";
import WsWebSocket from "ws";
import { z } from "zod";
import { WS_OPEN } from "../isolate/constants.ts";
import type { ClientEvent } from "../isolate/protocol.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";

const uint8ToBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const base64ToUint8 = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, "base64"));

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

// Node's native WebSocket doesn't support custom headers.
// Use the `ws` package which accepts { headers } in the constructor.
export const defaultCreateS2sWebSocket: CreateS2sWebSocket = (url, opts) =>
  new WsWebSocket(url, { headers: opts.headers }) as unknown as S2sWebSocket;

// ── Zod schemas for S2S server messages ─────────────────────────────────

const S2sMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.ready"), session_id: z.string() }).passthrough(),
  z.object({ type: z.literal("session.updated") }).passthrough(),
  z.object({ type: z.literal("input.speech.started") }),
  z.object({ type: z.literal("input.speech.stopped") }),
  z.object({ type: z.literal("transcript.user.delta"), text: z.string() }),
  z.object({ type: z.literal("transcript.user"), item_id: z.string(), text: z.string() }),
  z.object({ type: z.literal("reply.started"), reply_id: z.string() }),
  z.object({ type: z.literal("transcript.agent.delta"), delta: z.string() }).passthrough(),
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

function dispatchS2sMessage(emitter: Emitter<S2sEvents>, msg: S2sServerMessage): void {
  switch (msg.type) {
    case "session.ready":
      emitter.emit("ready", { sessionId: msg.session_id });
      break;
    case "session.updated":
      break;
    case "input.speech.started":
      emitter.emit("event", { type: "speech_started" });
      break;
    case "input.speech.stopped":
      emitter.emit("event", { type: "speech_stopped" });
      break;
    case "transcript.user.delta":
      emitter.emit("event", { type: "user_transcript", text: msg.text, isFinal: false });
      break;
    case "transcript.user":
      emitter.emit("event", { type: "user_transcript", text: msg.text, isFinal: true });
      break;
    case "reply.started":
      emitter.emit("replyStarted", { replyId: msg.reply_id });
      break;
    case "transcript.agent.delta":
      emitter.emit("event", { type: "agent_transcript", text: msg.delta, isFinal: false });
      break;
    case "transcript.agent":
      emitter.emit("event", {
        type: "agent_transcript",
        text: msg.text,
        isFinal: true,
        _interrupted: msg.interrupted,
      });
      break;
    case "tool.call":
      emitter.emit("event", {
        type: "tool_call",
        toolCallId: msg.call_id,
        toolName: msg.name,
        args: msg.args,
      });
      break;
    case "reply.done":
      if (msg.status === "interrupted") {
        emitter.emit("event", { type: "cancelled" });
      } else {
        emitter.emit("event", { type: "reply_done" });
      }
      break;
    case "session.error":
      if (msg.code === "session_not_found" || msg.code === "session_forbidden")
        emitter.emit("sessionExpired");
      else emitter.emit("error", new Error(msg.message));
      break;
    case "error":
      emitter.emit("error", new Error(msg.message));
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

export type S2sEvents = {
  ready: (detail: { sessionId: string }) => void;
  replyStarted: (detail: { replyId: string }) => void;
  sessionExpired: () => void;
  event: (event: S2sEvent) => void;
  audio: (detail: { audio: Uint8Array }) => void;
  error: (err: Error) => void;
  close: (code: number, reason: string) => void;
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

export function connectS2s(opts: ConnectS2sOptions): Promise<S2sHandle> {
  const { apiKey, config, createWebSocket, logger: log = consoleLogger } = opts;

  return new Promise((resolve, reject) => {
    log.info("S2S connecting", { url: config.wssUrl });

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
      const code = ev.code ?? 0;
      const reason = ev.reason ?? "";
      log.info("S2S WebSocket closed", { code, reason });
      if (!opened) {
        reject(new Error(`WebSocket closed before open (code: ${code})`));
      }
      emitter.emit("close", code, reason);
    });

    ws.addEventListener("error", (ev) => {
      const message = typeof ev.message === "string" ? ev.message : "WebSocket error";
      const errObj = new Error(message);
      log.error("S2S WebSocket error", { error: errObj.message });
      if (!opened) {
        reject(errObj);
      } else {
        emitter.emit("error", errObj);
      }
    });
  });
}
