// Copyright 2026 the AAI authors. MIT license.
// OpenAI Realtime API transport — implements Transport.

import type { JSONSchema7 } from "json-schema";
import WsWebSocket from "ws";
import { WS_OPEN } from "../../sdk/constants.ts";
import type { OpenaiRealtimeOptions } from "../../sdk/providers/s2s/openai-realtime.ts";
import { base64ToUint8, uint8ToBase64 } from "../_base64.ts";
import type { Logger } from "../runtime-config.ts";
import { consoleLogger } from "../runtime-config.ts";
import type { Transport, TransportCallbacks, TransportSessionConfig } from "./types.ts";

const DEFAULT_MODEL = "gpt-realtime";
const DEFAULT_VOICE = "alloy";
const DEFAULT_URL = "wss://api.openai.com/v1/realtime";

export type OpenaiRealtimeWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", fn: () => void): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", fn: (ev: { message?: string }) => void): void;
};

export type CreateOpenaiRealtimeWebSocket = (
  url: string,
  opts: { headers: Record<string, string> },
) => OpenaiRealtimeWebSocket;

// Node's native WebSocket doesn't support custom headers; the `ws` package does.
export const defaultCreateOpenaiRealtimeWebSocket: CreateOpenaiRealtimeWebSocket = (url, opts) =>
  new WsWebSocket(url, { headers: opts.headers }) as unknown as OpenaiRealtimeWebSocket;

export type OpenaiRealtimeToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: JSONSchema7;
};

export type OpenaiRealtimeTransportOptions = {
  apiKey: string;
  options: OpenaiRealtimeOptions;
  sessionConfig: TransportSessionConfig;
  toolSchemas: OpenaiRealtimeToolSchema[];
  toolChoice: "auto" | "required";
  callbacks: TransportCallbacks;
  sid: string;
  agent: string;
  createWebSocket?: CreateOpenaiRealtimeWebSocket;
  logger?: Logger;
};

export function createOpenaiRealtimeTransport(opts: OpenaiRealtimeTransportOptions): Transport {
  const log = opts.logger ?? consoleLogger;
  const createWs = opts.createWebSocket ?? defaultCreateOpenaiRealtimeWebSocket;
  const model = opts.options.model ?? DEFAULT_MODEL;
  const voice = opts.options.voice ?? DEFAULT_VOICE;
  const baseUrl = opts.options.url ?? DEFAULT_URL;

  let ws: OpenaiRealtimeWebSocket | null = null;
  let closing = false;
  const agentTranscriptBuffers = new Map<string, string>();
  type ToolBuffer = { callId: string; name: string; argsBuffer: string };
  const toolBuffers = new Map<string, ToolBuffer>();
  let currentResponseId: string | null = null;

  function send(payload: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WS_OPEN) {
      log.debug("OpenAI Realtime send dropped: socket not open", { type: payload.type });
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function sendSessionUpdate(): void {
    send({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice,
        instructions: opts.sessionConfig.systemPrompt,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad" },
        tools: opts.toolSchemas,
        tool_choice: opts.toolChoice,
      },
    });
  }

  async function start(): Promise<void> {
    const url = `${baseUrl}?model=${encodeURIComponent(model)}`;
    log.info("OpenAI Realtime connecting", { url });
    return new Promise((resolve, reject) => {
      const sock = createWs(url, {
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });
      ws = sock;
      let opened = false;

      sock.addEventListener("open", () => {
        opened = true;
        sendSessionUpdate();
        resolve();
      });
      sock.addEventListener("message", (ev) => handleMessage(ev.data));
      sock.addEventListener("close", (ev) => handleClose(ev.code ?? 0, ev.reason ?? ""));
      sock.addEventListener("error", (ev) => {
        const msg = typeof ev.message === "string" ? ev.message : "WebSocket error";
        if (!opened) {
          reject(new Error(msg));
          return;
        }
        if (closing) {
          log.info("OpenAI Realtime error during close", { error: msg });
          return;
        }
        opts.callbacks.onError("internal", msg);
      });
    });
  }

  function asString(v: unknown): string {
    return typeof v === "string" ? v : "";
  }

  function handleAudioDelta(obj: Record<string, unknown>): void {
    if (typeof obj.delta === "string") {
      opts.callbacks.onAudioChunk(base64ToUint8(obj.delta));
    }
  }

  function handleUserTranscript(obj: Record<string, unknown>): void {
    if (typeof obj.transcript === "string") {
      opts.callbacks.onUserTranscript(obj.transcript);
    }
  }

  function handleResponseCreated(obj: Record<string, unknown>): void {
    const resp = obj.response as { id?: unknown } | undefined;
    const id = asString(resp?.id);
    currentResponseId = id;
    opts.callbacks.onReplyStarted(id);
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
    if (text) opts.callbacks.onAgentTranscript(text, false);
  }

  function clearTurnBuffers(): void {
    agentTranscriptBuffers.clear();
    toolBuffers.clear();
  }

  function handleResponseDone(): void {
    currentResponseId = null;
    clearTurnBuffers();
    opts.callbacks.onReplyDone();
  }

  function handleErrorEvent(obj: Record<string, unknown>): void {
    const err = obj.error as { message?: unknown } | undefined;
    const message = typeof err?.message === "string" ? err.message : "OpenAI Realtime error";
    clearTurnBuffers();
    opts.callbacks.onError("internal", message);
  }

  function handleOutputItemAdded(obj: Record<string, unknown>): void {
    const item = obj.item as
      | { id?: string; type?: string; name?: string; call_id?: string }
      | undefined;
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
    try {
      const parsed = JSON.parse(argsStr);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      log.warn("OpenAI Realtime: invalid tool args JSON", { name, callId });
    }
    return {};
  }

  function handleFunctionCallArgsDone(obj: Record<string, unknown>): void {
    const id = asString(obj.item_id);
    const buf = toolBuffers.get(id);
    toolBuffers.delete(id);
    const callId = asString(obj.call_id) || (buf?.callId ?? "");
    const name = asString(obj.name) || (buf?.name ?? "");
    const argsStr = asString(obj.arguments) || (buf?.argsBuffer ?? "");
    const args = parseToolArgs(argsStr, name, callId);
    opts.callbacks.onToolCall(callId, name, args);
  }

  function handleMessage(data: unknown): void {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      log.warn("OpenAI Realtime: invalid JSON");
      return;
    }
    if (typeof raw !== "object" || raw === null) return;
    const obj = raw as Record<string, unknown>;
    switch (obj.type) {
      case "response.audio.delta":
        handleAudioDelta(obj);
        return;
      case "response.audio.done":
        opts.callbacks.onAudioDone();
        return;
      case "input_audio_buffer.speech_started":
        opts.callbacks.onSpeechStarted();
        return;
      case "input_audio_buffer.speech_stopped":
        opts.callbacks.onSpeechStopped();
        return;
      case "conversation.item.input_audio_transcription.completed":
        handleUserTranscript(obj);
        return;
      case "response.created":
        handleResponseCreated(obj);
        return;
      case "response.audio_transcript.delta":
        handleAgentTranscriptDelta(obj);
        return;
      case "response.audio_transcript.done":
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
        return;
    }
  }

  function handleClose(code: number, reason: string): void {
    if (closing) {
      log.info("OpenAI Realtime closed", { code, reason });
      return;
    }
    log.warn("OpenAI Realtime closed unexpectedly", { code, reason });
    opts.callbacks.onError("connection", `OpenAI Realtime closed (code=${code})`);
  }

  async function stop(): Promise<void> {
    closing = true;
    ws?.close();
    ws = null;
  }

  return {
    start,
    stop,
    sendUserAudio(bytes) {
      if (!ws || ws.readyState !== WS_OPEN) return;
      ws.send(`{"type":"input_audio_buffer.append","audio":"${uint8ToBase64(bytes)}"}`);
    },
    sendToolResult(callId, result) {
      send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: result },
      });
      send({ type: "response.create" });
    },
    cancelReply() {
      if (currentResponseId === null) return;
      send({ type: "response.cancel" });
      currentResponseId = null;
      clearTurnBuffers();
      opts.callbacks.onCancelled();
    },
  };
}
