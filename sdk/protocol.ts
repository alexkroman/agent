// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket wire-format types shared by server and client.
 *
 * Note: this module is for internal use only and should not be used directly.
 *
 * @module
 */

import { z } from "zod";
import type { Message, StepInfo } from "./types.ts";

/**
 * Default sample rate for speech-to-text audio in Hz.
 *
 * This is the sample rate expected by the STT provider (AssemblyAI).
 */
export const DEFAULT_STT_SAMPLE_RATE = 16_000;

/**
 * Default sample rate for text-to-speech audio in Hz.
 *
 * This is the sample rate produced by the TTS provider.
 */
export const DEFAULT_TTS_SAMPLE_RATE = 24_000;

/**
 * Audio codec identifier used in the wire protocol.
 *
 * All audio frames are 16-bit signed PCM, little-endian, mono.
 */
export const AUDIO_FORMAT = "pcm16" as const;

/**
 * Binary audio frame specification. All audio exchanged over the WebSocket as
 * binary frames MUST conform to this spec. Any change here is a breaking
 * protocol change.
 */
const _bitsPerSample = 16 as const;
const _channels = 1 as const;

/** Specification for binary audio frames exchanged over WebSocket. */
export const AudioFrameSpec = {
  /** Audio codec identifier sent in the `ready` message. */
  format: AUDIO_FORMAT,
  /** Signed 16-bit integer samples. */
  bitsPerSample: _bitsPerSample,
  /** Little-endian byte order. */
  endianness: "little" as const,
  /** Mono audio. */
  channels: _channels,
  /** Bytes per sample — derived from bitsPerSample and channels. */
  bytesPerSample: (_bitsPerSample / 8) * _channels,
} as const;

/**
 * KV operation request sent from the worker to the host via postMessage RPC.
 *
 * This is a discriminated union on the `op` field, representing the four
 * key-value store operations available to sandboxed agent workers.
 */
export type KvRequest =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: string; ttl?: number | undefined }
  | { op: "del"; key: string }
  | {
      op: "list";
      prefix: string;
      limit?: number | undefined;
      reverse?: boolean | undefined;
    };

/** Zod schema for {@linkcode KvRequest}. */
export const KvRequestBaseSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get"), key: z.string().min(1) }),
  z.object({
    op: z.literal("set"),
    key: z.string().min(1),
    value: z.string(),
    ttl: z.number().int().positive().optional(),
  }),
  z.object({ op: z.literal("del"), key: z.string().min(1) }),
  z.object({
    op: z.literal("list"),
    prefix: z.string(),
    limit: z.number().int().positive().optional(),
    reverse: z.boolean().optional(),
  }),
]);

// ─── Timeout constants ─────────────────────────────────────────────────────

/** Default timeout for agent lifecycle hooks (onConnect, onTurn, etc). */
export const HOOK_TIMEOUT_MS = 5_000;

/** Default timeout for tool execution in the worker. */
export const TOOL_EXECUTION_TIMEOUT_MS = 30_000;

// ─── Error codes ───────────────────────────────────────────────────────────

/** Error codes for categorizing session errors on the wire. */
export type SessionErrorCode =
  | "stt"
  | "llm"
  | "tts"
  | "tool"
  | "protocol"
  | "connection"
  | "audio"
  | "internal";

/** Zod schema for {@linkcode SessionErrorCode}. */
export const SessionErrorCodeSchema = z.enum([
  "stt",
  "llm",
  "tts",
  "tool",
  "protocol",
  "connection",
  "audio",
  "internal",
]);

// ─── Client events ─────────────────────────────────────────────────────────

/**
 * Discriminated union of all server→client session events.
 *
 * Sent via a single `event()` RPC method instead of one method per type.
 */
export type ClientEvent =
  | { type: "speech_started" }
  | { type: "speech_stopped" }
  | { type: "transcript"; text: string; isFinal: false }
  | {
      type: "transcript";
      text: string;
      isFinal: true;
      turnOrder?: number | undefined;
    }
  | { type: "turn"; text: string; turnOrder?: number | undefined }
  | { type: "chat"; text: string }
  | { type: "chat_delta"; text: string }
  | {
      type: "tool_call_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: "tool_call_done"; toolCallId: string; result: string }
  | { type: "tts_done" }
  | { type: "cancelled" }
  | { type: "reset" }
  | { type: "error"; code: SessionErrorCode; message: string };

/** Zod schema for a transcript event (partial or final). */
const TranscriptEventSchema = z.object({
  type: z.literal("transcript"),
  text: z.string(),
  isFinal: z.boolean(),
  turnOrder: z.number().int().nonnegative().optional(),
});

/** Zod schema for {@linkcode ClientEvent}. */
export const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("speech_started") }),
  z.object({ type: z.literal("speech_stopped") }),
  TranscriptEventSchema,
  z.object({
    type: z.literal("turn"),
    text: z.string(),
    turnOrder: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("chat"), text: z.string() }),
  z.object({ type: z.literal("chat_delta"), text: z.string() }),
  z.object({
    type: z.literal("tool_call_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool_call_done"),
    toolCallId: z.string(),
    result: z.string().max(4000),
  }),
  z.object({ type: z.literal("tts_done") }),
  z.object({ type: z.literal("cancelled") }),
  z.object({ type: z.literal("reset") }),
  z.object({
    type: z.literal("error"),
    code: SessionErrorCodeSchema,
    message: z.string(),
  }),
]);

/**
 * Typed interface for pushing session events to a connected client.
 *
 * For WebSocket sessions this sends JSON text frames and binary audio frames.
 */
export interface ClientSink {
  /** Whether the underlying connection is open and accepting calls. */
  readonly open: boolean;
  /** Push a session event to the client. */
  event(e: ClientEvent): void;
  /** Send a single TTS audio chunk to the client. */
  playAudioChunk(chunk: Uint8Array): void;
  /** Signal that TTS audio is complete. */
  playAudioDone(): void;
}

// ─── WebSocket message types ────────────────────────────────────────────────

/** Supported audio formats for the wire protocol. */
export type AudioFormatId = "pcm16";

/** Protocol-level session config returned to the client on connect. */
export type ReadyConfig = {
  audioFormat: AudioFormatId;
  sampleRate: number;
  ttsSampleRate: number;
};

/** Client→server text messages (binary frames carry raw PCM16 audio). */
export type ClientMessage =
  | { type: "audio_ready" }
  | { type: "cancel" }
  | { type: "reset" }
  | {
      type: "history";
      messages: readonly { role: "user" | "assistant"; text: string }[];
    };

/** Server→client text messages (binary frames carry raw PCM16 audio). */
export type ServerMessage =
  | ({ type: "config" } & ReadyConfig)
  | { type: "audio_done" }
  | ClientEvent;

/** Zod schema for {@linkcode ClientMessage}. */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("audio_ready") }),
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("reset") }),
  z.object({
    type: z.literal("history"),
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          text: z.string().max(100_000),
        }),
      )
      .max(200),
  }),
]);

// ─── Worker RPC interfaces ─────────────────────────────────────────────────

/**
 * API shape the host process exposes to the sandboxed worker.
 *
 * Since workers run with all permissions denied, they use this interface
 * to proxy network requests and KV operations back to the host.
 */
export type HostApi = {
  fetch(req: {
    url: string;
    method: string;
    headers: Readonly<Record<string, string>>;
    body: string | null;
  }): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  }>;
  kv(req: KvRequest): Promise<{ result: unknown }>;
  vectorSearch(req: { query: string; topK: number }): Promise<string>;
};

/** Combined turn configuration resolved from the worker before a turn starts. */
export type TurnConfig = {
  maxSteps?: number;
  activeTools?: string[];
};

/** Worker-side RPC target interface (host calls these methods). */
export interface WorkerRpcApi {
  withEnv(env: Record<string, string>): WorkerRpcApi;
  executeTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    sessionId: string | undefined,
    messages: readonly Message[] | undefined,
  ): Promise<string>;
  onConnect(sessionId: string): Promise<void>;
  onDisconnect(sessionId: string): Promise<void>;
  onTurn(sessionId: string, text: string): Promise<void>;
  onError(sessionId: string, error: string): void;
  onStep(sessionId: string, step: StepInfo): Promise<void>;
  resolveTurnConfig(sessionId: string): Promise<TurnConfig | null>;
}
