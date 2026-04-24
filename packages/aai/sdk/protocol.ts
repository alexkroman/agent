// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket wire-format types shared by server and client.
 *
 * Note: this module is for internal use only and should not be used directly.
 */

import { z } from "zod";

import { MAX_TOOL_RESULT_CHARS } from "./constants.ts";

/**
 * Audio codec identifier used in the wire protocol.
 *
 * All audio frames are 16-bit signed PCM, little-endian, mono.
 */
const AUDIO_FORMAT = "pcm16";

/**
 * Minimal envelope schema for two-phase message parsing.
 *
 * When a strict schema (ServerMessageSchema / ClientMessageSchema) rejects a
 * message, this schema determines whether the message is a valid but
 * *unrecognised* type (safe to ignore during rolling upgrades) or genuinely
 * malformed (should be warned about).
 */
const MessageEnvelopeSchema = z.object({ type: z.string() }).passthrough();

/**
 * Two-phase message parse: tries the strict schema first, then falls back to
 * the envelope to distinguish unknown-but-valid types (safe to ignore during
 * rolling upgrades) from genuinely malformed messages.
 *
 * Return value when `ok: false`:
 * - `malformed: true` — message doesn't even have a `{ type: string }` shape;
 *   likely corrupt data, should warn
 * - `malformed: false` — has a valid `type` field but the type is unrecognised;
 *   safe to ignore (e.g. new message type from a newer server version)
 */
export function lenientParse<T>(
  schema: z.ZodType<T>,
  json: unknown,
): { ok: true; data: T } | { ok: false; malformed: boolean; error: string } {
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  const malformed = !MessageEnvelopeSchema.safeParse(json).success;
  return { ok: false, malformed, error: result.error.message };
}

/** Zod schema for the KV "get" operation. */
export const KvGetSchema = z.object({ op: z.literal("get"), key: z.string().min(1) });

/** Zod schema for the KV "set" operation. */
export const KvSetSchema = z.object({
  op: z.literal("set"),
  key: z.string().min(1),
  value: z.unknown(),
  /** Time-to-live in **milliseconds**. */
  expireIn: z.number().int().positive().optional(),
});

/** Zod schema for the KV "del" operation. */
export const KvDelSchema = z.object({ op: z.literal("del"), key: z.string().min(1) });

/** Zod schema for KV operation requests from the worker to the host. */
export const KvRequestSchema = z.discriminatedUnion("op", [KvGetSchema, KvSetSchema, KvDelSchema]);

/** KV operation request — discriminated union on the `op` field. */
export type KvRequest = z.infer<typeof KvRequestSchema>;

// ─── Error codes ───────────────────────────────────────────────────────────

/**
 * Zod schema for session error codes.
 * @public
 */
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

/**
 * Error codes for categorizing session errors on the wire.
 *
 * @public
 */
export type SessionErrorCode = z.infer<typeof SessionErrorCodeSchema>;

// ─── Client events ─────────────────────────────────────────────────────────

/** Helper: simple event with only a type field. */
const ev = <T extends string>(t: T) => z.object({ type: z.literal(t) });

const turnOrder = z.number().int().nonnegative().optional();

/** Zod schema for {@link ClientEvent}. */
export const ClientEventSchema = z.discriminatedUnion("type", [
  ev("speech_started"),
  ev("speech_stopped"),
  z.object({
    type: z.literal("user_transcript"),
    text: z.string(),
    turnOrder,
  }),
  z.object({
    type: z.literal("agent_transcript"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool_call"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool_call_done"),
    toolCallId: z.string(),
    result: z.string().max(MAX_TOOL_RESULT_CHARS),
  }),
  ev("reply_done"),
  ev("cancelled"),
  ev("reset"),
  ev("idle_timeout"),
  z.object({ type: z.literal("error"), code: SessionErrorCodeSchema, message: z.string() }),
  z.object({
    type: z.literal("custom_event"),
    event: z.string().min(1),
    data: z.unknown(),
  }),
]);

/** Discriminated union of all server→client session events. */
export type ClientEvent = z.infer<typeof ClientEventSchema>;

/**
 * Typed interface for pushing session events to a connected client.
 *
 * Events (`event`, `playAudioDone`) send JSON text frames. Audio chunks
 * (`playAudioChunk`) send raw PCM16 binary frames.
 */
export interface ClientSink {
  /** True when the underlying connection is open and will accept calls. */
  readonly open: boolean;
  /** Push a session event (JSON text frame) to the client. */
  event(e: ClientEvent): void;
  /** Send a single PCM16 audio chunk (raw binary frame) to the client. */
  playAudioChunk(chunk: Uint8Array): void;
  /** Signal that TTS audio is complete (JSON text frame). */
  playAudioDone(): void;
}

// ─── WebSocket message types ────────────────────────────────────────────────

/** Zod schema for {@link ReadyConfig}. */
export const ReadyConfigSchema = z.object({
  audioFormat: z.enum(["pcm16"]),
  sampleRate: z.number().int().positive(),
  ttsSampleRate: z.number().int().positive(),
});

/** Protocol-level session config returned to the client on connect. */
export type ReadyConfig = z.infer<typeof ReadyConfigSchema>;

/** Zod schema for server→client text messages. */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("config"),
    audioFormat: z.string(),
    sampleRate: z.number(),
    ttsSampleRate: z.number(),
    /** Session ID for this connection. Clients can reconnect with
     *  `?sessionId=<id>` to resume a persisted session. */
    sessionId: z.string().optional(),
  }),
  ev("audio_done"),
  ...ClientEventSchema.options,
]);

/** Server→client text messages (binary frames carry raw PCM16 audio). */
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Zod schema for client→server text messages. */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  ev("audio_ready"),
  ev("cancel"),
  ev("reset"),
  z.object({
    type: z.literal("history"),
    messages: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(100_000) }))
      .max(200),
  }),
]);

/** Client→server text messages (binary frames carry raw PCM16 audio). */
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ─── Ready config builder ───────────────────────────────────────────────────

/** Build the protocol-level session config from S2S sample rates. */
export function buildReadyConfig(s2sConfig: {
  inputSampleRate: number;
  outputSampleRate: number;
}): ReadyConfig {
  return {
    audioFormat: AUDIO_FORMAT,
    sampleRate: s2sConfig.inputSampleRate,
    ttsSampleRate: s2sConfig.outputSampleRate,
  };
}
