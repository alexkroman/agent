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
/** Specification for binary audio frames exchanged over WebSocket. */
export const AudioFrameSpec = {
  format: AUDIO_FORMAT,
  bitsPerSample: 16,
  endianness: "little",
  channels: 1,
  bytesPerSample: 2,
} as const;

/** Zod schema for KV operation requests from the worker to the host. */
export const KvRequestSchema = z.discriminatedUnion("op", [
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
  z.object({ op: z.literal("keys"), pattern: z.string().optional() }),
]);

/** KV operation request — discriminated union on the `op` field. */
export type KvRequest = z.infer<typeof KvRequestSchema>;

// ─── Vector request types ───────────────────────────────────────────────────

/** Zod schema for vector operation requests. */
export const VectorRequestSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert"),
    id: z.string().min(1),
    data: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    op: z.literal("query"),
    text: z.string().min(1),
    topK: z.number().int().positive().max(100).optional(),
    filter: z.string().optional(),
  }),
  z.object({
    op: z.literal("remove"),
    ids: z.array(z.string().min(1)).min(1),
  }),
]);

/** Vector operation request — discriminated union on the `op` field. */
export type VectorRequest = z.infer<typeof VectorRequestSchema>;

// ─── Timeout constants ─────────────────────────────────────────────────────

/** Default timeout for agent lifecycle hooks (onConnect, onTurn, etc). */
export const HOOK_TIMEOUT_MS = 5_000;

/** Default timeout for tool execution in the worker. */
export const TOOL_EXECUTION_TIMEOUT_MS = 30_000;

// ─── Error codes ───────────────────────────────────────────────────────────

/** Zod schema for session error codes. */
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

/** Error codes for categorizing session errors on the wire. */
export type SessionErrorCode = z.infer<typeof SessionErrorCodeSchema>;

// ─── Client events ─────────────────────────────────────────────────────────

/** Helper: simple event with only a type field. */
const ev = <T extends string>(t: T) => z.object({ type: z.literal(t) });
/** Helper: event with type + text. */
const textEv = <T extends string>(t: T) => z.object({ type: z.literal(t), text: z.string() });

const turnOrder = z.number().int().nonnegative().optional();

/** Zod schema for {@linkcode ClientEvent}. */
export const ClientEventSchema = z.discriminatedUnion("type", [
  ev("speech_started"),
  ev("speech_stopped"),
  z.object({ type: z.literal("transcript"), text: z.string(), isFinal: z.boolean(), turnOrder }),
  textEv("turn").extend({ turnOrder }),
  textEv("chat"),
  textEv("chat_delta"),
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
  ev("tts_done"),
  ev("cancelled"),
  ev("reset"),
  z.object({ type: z.literal("error"), code: SessionErrorCodeSchema, message: z.string() }),
]);

/** Discriminated union of all server→client session events. */
export type ClientEvent = z.infer<typeof ClientEventSchema>;

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

/** Server→client text messages (binary frames carry raw PCM16 audio). */
export type ServerMessage =
  | ({ type: "config" } & ReadyConfig)
  | { type: "audio_done" }
  | ClientEvent;

/** Zod schema for client→server text messages. */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  ev("audio_ready"),
  ev("cancel"),
  ev("reset"),
  z.object({
    type: z.literal("history"),
    messages: z
      .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(100_000) }))
      .max(200),
  }),
]);

/** Client→server text messages (binary frames carry raw PCM16 audio). */
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

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
