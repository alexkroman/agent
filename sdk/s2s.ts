// Copyright 2025 the AAI authors. MIT license.
/**
 * Speech-to-Speech WebSocket client for AssemblyAI's S2S API.
 *
 * Cross-runtime: accepts a WebSocket factory and Logger instead of
 * importing `ws` or `@std/log` directly.
 *
 * @module
 */
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";

// ─── Cross-runtime base64 helpers ───────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── WebSocket abstraction ──────────────────────────────────────────────────

/** Minimal WebSocket interface for the S2S client. */
export type S2sWebSocket = {
  readonly readyState: number;
  send(data: string): void;
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
  parameters: Record<string, unknown>;
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

    function send(msg: Record<string, unknown>): void {
      if (ws.readyState !== WS_OPEN) return;
      const type = msg.type as string;
      if (type !== "input.audio") {
        log.info(`S2S >> ${JSON.stringify(msg)}`);
      }
      ws.send(JSON.stringify(msg));
    }

    const handle: S2sHandle = Object.assign(target, {
      sendAudio(audio: Uint8Array): void {
        send({ type: "input.audio", audio: uint8ToBase64(audio) });
      },

      sendToolResult(callId: string, result: string): void {
        send({ type: "tool.result", call_id: callId, result });
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

    ws.on("message", (data: unknown) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }

      const type = msg.type as string;

      if (type !== "reply.audio") {
        log.info(`S2S << ${JSON.stringify(msg)}`);
      }

      switch (type) {
        case "session.ready":
          target.dispatchEvent(
            new CustomEvent("ready", {
              detail: { session_id: msg.session_id as string },
            }),
          );
          break;
        case "session.updated":
          target.dispatchEvent(new CustomEvent("session_updated", { detail: msg }));
          break;
        case "input.speech.started":
          target.dispatchEvent(new CustomEvent("speech_started"));
          break;
        case "input.speech.stopped":
          target.dispatchEvent(new CustomEvent("speech_stopped"));
          break;
        case "transcript.user.delta":
          target.dispatchEvent(
            new CustomEvent("user_transcript_delta", {
              detail: { text: msg.text as string },
            }),
          );
          break;
        case "transcript.user":
          target.dispatchEvent(
            new CustomEvent("user_transcript", {
              detail: {
                item_id: msg.item_id as string,
                text: msg.text as string,
              },
            }),
          );
          break;
        case "reply.started":
          target.dispatchEvent(
            new CustomEvent("reply_started", {
              detail: { reply_id: msg.reply_id as string },
            }),
          );
          break;
        case "reply.audio": {
          const audioBytes = base64ToUint8(msg.data as string);
          target.dispatchEvent(new CustomEvent("audio", { detail: { audio: audioBytes } }));
          break;
        }
        case "transcript.agent":
          target.dispatchEvent(
            new CustomEvent("agent_transcript", {
              detail: { text: msg.text as string },
            }),
          );
          break;
        case "tool.call":
          target.dispatchEvent(
            new CustomEvent("tool_call", {
              detail: {
                call_id: msg.call_id as string,
                name: msg.name as string,
                args: (msg.args ?? {}) as Record<string, unknown>,
              },
            }),
          );
          break;
        case "reply.done":
          target.dispatchEvent(
            new CustomEvent("reply_done", {
              detail: { status: (msg.status as string) ?? undefined },
            }),
          );
          break;
        case "session.error": {
          const code = msg.code as string;
          const isExpired = code === "session_not_found" || code === "session_forbidden";
          target.dispatchEvent(
            new CustomEvent(isExpired ? "session_expired" : "error", {
              detail: { code, message: msg.message as string },
            }),
          );
          break;
        }
      }
    });

    ws.on("close", (code: unknown, reason: unknown) => {
      log.info("S2S WebSocket closed", {
        code: code as number,
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
