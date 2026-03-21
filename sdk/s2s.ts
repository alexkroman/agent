// Copyright 2025 the AAI authors. MIT license.
/**
 * Speech-to-Speech WebSocket client for AssemblyAI's S2S API.
 *
 * Cross-runtime: accepts a WebSocket factory and Logger instead of
 * importing `ws` or `@std/log` directly.
 *
 * @module
 */
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";

// ─── Base64 helpers (native Buffer for C++-speed encode/decode) ─────────────

function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function base64ToUint8(base64: string): Uint8Array {
  const buf = Buffer.from(base64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ─── WebSocket abstraction ──────────────────────────────────────────────────

/** Minimal WebSocket interface for the S2S client. */
export type S2sWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  /** Send raw binary audio. When present, sendAudio uses this for zero-copy transfer. */
  sendBinary?(data: ArrayBuffer): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

/** WebSocket readyState constant for OPEN. */
const WS_OPEN = 1;

/** Factory for creating WebSocket connections (e.g. the `ws` package). */
export type CreateS2sWebSocket = (
  url: string,
  opts: { headers: Record<string, string> },
) => S2sWebSocket;

// ─── Incoming S2S message schema ─────────────────────────────────────────────

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
  // reply.audio is handled on the fast path before Zod — see message handler.
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

// biome-ignore format: compact lookup table
type Msg = Record<string, unknown>;
const S2S_DISPATCH: Record<string, (m: Msg) => [string, unknown] | undefined> = {
  "session.ready": (m) => ["ready", { session_id: m.session_id }],
  "session.updated": (m) => ["session_updated", m],
  "input.speech.started": () => ["speech_started", undefined],
  "input.speech.stopped": () => ["speech_stopped", undefined],
  "transcript.user.delta": (m) => ["user_transcript_delta", { text: m.text }],
  "transcript.user": (m) => ["user_transcript", { item_id: m.item_id, text: m.text }],
  "reply.started": (m) => ["reply_started", { reply_id: m.reply_id }],
  "transcript.agent.delta": (m) => ["agent_transcript_delta", { text: m.delta }],
  "transcript.agent": (m) => ["agent_transcript", { text: m.text }],
  "tool.call": (m) => ["tool_call", { call_id: m.call_id, name: m.name, args: m.args }],
  "reply.done": (m) => ["reply_done", { status: m.status }],
  "session.error": (m) => [
    m.code === "session_not_found" || m.code === "session_forbidden" ? "session_expired" : "error",
    { code: m.code, message: m.message },
  ],
  error: (m) => ["error", { code: "connection", message: m.message }],
  "reply.content_part.started": () => undefined,
  "reply.content_part.done": () => undefined,
};

/** Dispatch a parsed S2S server message to the EventTarget. */
function dispatchS2sMessage(target: EventTarget, msg: S2sServerMessage): void {
  const entry = S2S_DISPATCH[msg.type]?.(msg as Msg);
  if (entry) target.dispatchEvent(new CustomEvent(entry[0], { detail: entry[1] }));
}

// ─── Types ──────────────────────────────────────────────────────────────────

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

export type S2sHandle = EventTarget & {
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
 * Returns an {@linkcode S2sHandle} that extends EventTarget. Consumers
 * listen for events: `ready`, `speech_started`, `speech_stopped`,
 * `user_transcript_delta`, `user_transcript`, `reply_started`,
 * `reply_done`, `audio`, `agent_transcript`, `tool_call`,
 * `session_expired`, `error`, `close`.
 */
export function connectS2s(opts: ConnectS2sOptions): Promise<S2sHandle> {
  const { apiKey, config, createWebSocket, logger: log = consoleLogger } = opts;

  return new Promise((resolve, reject) => {
    log.debug("S2S connecting", { url: config.wssUrl });

    const ws = createWebSocket(config.wssUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const target = new EventTarget();
    let opened = false;

    function send(msg: { type: string; [key: string]: unknown }): void {
      if (ws.readyState !== WS_OPEN) return;
      const json = JSON.stringify(msg);
      if (msg.type !== "input.audio") {
        log.debug(
          `S2S >> ${msg.type}`,
          msg.type === "session.update" ? { payload: json } : undefined,
        );
      }
      ws.send(json);
    }

    const handle: S2sHandle = Object.assign(target, {
      sendAudio(audio: Uint8Array): void {
        if (ws.readyState !== WS_OPEN) return;
        if (ws.sendBinary) {
          // Bridged mode: send raw PCM, host does base64+JSON wrap.
          const ab = (audio.buffer as ArrayBuffer).slice(
            audio.byteOffset,
            audio.byteOffset + audio.byteLength,
          );
          ws.sendBinary(ab);
        } else {
          // Direct mode: build JSON inline to avoid intermediate object allocation.
          ws.send(`{"type":"input.audio","audio":"${uint8ToBase64(audio)}"}`);
        }
      },

      sendToolResult(callId: string, result: string): void {
        const msg = { type: "tool.result", call_id: callId, result };
        log.debug("S2S >> tool.result", { call_id: callId, resultLength: result.length });
        send(msg);
      },

      updateSession(sessionConfig: S2sSessionConfig): void {
        send({ type: "session.update", session: sessionConfig });
      },

      resumeSession(sessionId: string): void {
        send({ type: "session.resume", session_id: sessionId });
      },

      close(): void {
        log.debug("S2S closing");
        ws.close();
      },
    });

    ws.on("open", () => {
      opened = true;
      log.info("S2S WebSocket open");
      resolve(handle);
    });

    // Bridged mode: host pre-decodes reply.audio and sends raw PCM as "audio" event.
    ws.on("audio", (data: unknown) => {
      const ab = data as ArrayBuffer;
      target.dispatchEvent(new CustomEvent("audio", { detail: { audio: new Uint8Array(ab) } }));
    });

    ws.on("message", (data: unknown) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }

      // Fast path: reply.audio is ~95% of traffic — skip Zod, skip logging.
      // Only reached in direct mode (self-hosted); bridged mode uses "audio" event above.
      const obj = raw as { type?: unknown; data?: unknown };
      if (
        obj.type !== "reply.audio" &&
        obj.type !== "input.audio" &&
        obj.type !== "transcript.agent.delta"
      ) {
        log.info(`S2S << ${obj.type}`);
      }
      if (obj.type === "reply.audio" && typeof obj.data === "string") {
        const audioBytes = base64ToUint8(obj.data);
        target.dispatchEvent(new CustomEvent("audio", { detail: { audio: audioBytes } }));
        return;
      }

      const parsed = S2sServerMessageSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn(
          `S2S << unrecognised message type: ${obj.type ?? JSON.stringify(raw).slice(0, 200)}`,
        );
        return;
      }
      const msg = parsed.data;
      dispatchS2sMessage(target, msg);
    });

    ws.on("close", (code: unknown, reason: unknown) => {
      log.info("S2S WebSocket closed", {
        code: typeof code === "number" ? code : 0,
        reason:
          reason instanceof Uint8Array ? new TextDecoder().decode(reason) : String(reason ?? ""),
      });
      target.dispatchEvent(new CustomEvent("close"));
    });

    ws.on("error", (err: unknown) => {
      const errObj = err instanceof Error ? err : new Error(String(err));
      log.error("S2S WebSocket error", { error: errObj.message });
      if (!opened) {
        reject(errObj);
      } else {
        target.dispatchEvent(
          new CustomEvent("error", {
            detail: { code: "ws_error", message: errObj.message },
          }),
        );
      }
    });
  });
}
