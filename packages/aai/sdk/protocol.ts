// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket wire-format types shared by server and client.
 *
 * Note: this module is for internal use only and should not be used directly.
 */

import { z } from "zod";

import { ToolSchemaSchema } from "./_internal-types.ts";
import {
  MAX_AUDIO_SAMPLE_RATE,
  MAX_CLIENT_EVENT_NAME_LENGTH,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TRANSCRIPT_CHARS,
} from "./constants.ts";

// The pre-connection client-config endpoint's wire format is part of the
// same protocol surface — re-exported so clients import one subpath.
export {
  buildClientConfig,
  CLIENT_CONFIG_PATH,
  type ClientConfigResponse,
  ClientConfigResponseSchema,
} from "./client-config.ts";

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
 * - `malformed: true` — message doesn't have a `{ type: string }` shape (likely
 *   corrupt data), OR its `type` is one of `knownTypes` but it still failed
 *   strict validation (e.g. a `tool_result` missing `toolCallId`); both should
 *   warn
 * - `malformed: false` — has a valid `type` field whose value is unrecognised;
 *   safe to ignore (e.g. new message type from a newer server version)
 *
 * Passing `knownTypes` is what separates "unknown newer-version type" from
 * "known type that failed validation" — without it, an invalid known message
 * is silently swallowed as if it were a forward-compat unknown type.
 */
export function lenientParse<T>(
  schema: z.ZodType<T>,
  json: unknown,
  knownTypes?: ReadonlySet<string>,
): { ok: true; data: T } | { ok: false; malformed: boolean; error: string } {
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  const envelope = MessageEnvelopeSchema.safeParse(json);
  const malformed = !envelope.success || (knownTypes?.has(envelope.data.type) ?? false);
  return { ok: false, malformed, error: result.error.message };
}

/** Discriminator literal values (the known `type`s) of a discriminated union. */
function discriminatorValues(union: z.ZodDiscriminatedUnion): ReadonlySet<string> {
  const key = union.def.discriminator;
  const values = new Set<string>();
  for (const option of union.options) {
    const field = (option as z.ZodObject).shape[key];
    if (field instanceof z.ZodLiteral && typeof field.value === "string") {
      values.add(field.value);
    }
  }
  return values;
}

/** Zod schema for the Vector "upsert" operation. */
export const VectorUpsertSchema = z.object({
  op: z.literal("upsert"),
  id: z.string().min(1),
  text: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Zod schema for the Vector "query" operation. */
export const VectorQuerySchema = z.object({
  op: z.literal("query"),
  text: z.string().min(1),
  topK: z.number().int().positive().max(100).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
});

/** Zod schema for the Vector "delete" operation. */
export const VectorDeleteSchema = z.object({
  op: z.literal("delete"),
  ids: z.union([z.string().min(1), z.array(z.string().min(1)).max(1000)]),
});

/** Zod schema for Vector operation requests from the worker to the host. */
export const VectorRequestSchema = z.discriminatedUnion("op", [
  VectorUpsertSchema,
  VectorQuerySchema,
  VectorDeleteSchema,
]);

/** Vector operation request — discriminated union on the `op` field. */
export type VectorRequest = z.infer<typeof VectorRequestSchema>;

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

/** Zod schema for {@link ClientEvent}. */
export const ClientEventSchema = z.discriminatedUnion("type", [
  ev("speech_started"),
  ev("speech_stopped"),
  z.object({
    type: z.literal("user_transcript"),
    text: z.string().max(MAX_TRANSCRIPT_CHARS),
  }),
  /**
   * Interim (in-progress) user transcript — live captions while the user is
   * still speaking. Pipeline mode forwards STT partials here; the committed
   * turn still arrives as `user_transcript`. Clients on older protocol
   * versions drop the unknown type via `lenientParse`.
   */
  z.object({
    type: z.literal("user_transcript_partial"),
    text: z.string().max(MAX_TRANSCRIPT_CHARS),
  }),
  z.object({
    type: z.literal("agent_transcript"),
    text: z.string().max(MAX_TRANSCRIPT_CHARS),
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
  z.object({
    type: z.literal("error"),
    code: SessionErrorCodeSchema,
    message: z.string().max(MAX_ERROR_MESSAGE_CHARS),
    /**
     * False for turn-level errors the session survives (e.g. a failed
     * one-shot transcription): the client should surface the message but
     * keep the session interactive. Absent means fatal — the historical
     * semantics, where an error always followed a session teardown.
     */
    fatal: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("custom_event"),
    event: z.string().min(1).max(MAX_CLIENT_EVENT_NAME_LENGTH),
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
    // Bounded: these numbers feed client-side allocations (the playback
    // worklet's rate*60 ring buffer), so an unbounded server value would be
    // an allocation-size lever against the client.
    sampleRate: z.number().int().positive().max(MAX_AUDIO_SAMPLE_RATE),
    ttsSampleRate: z.number().int().positive().max(MAX_AUDIO_SAMPLE_RATE),
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
  z.object({
    type: z.literal("tool_result"),
    toolCallId: z.string().min(1),
    result: z.string().max(MAX_TOOL_RESULT_CHARS),
    error: z.string().optional(),
  }),
]);

/** The set of recognised client→server message `type` values — pass to
 *  `lenientParse` so a known-but-invalid message warns instead of being
 *  silently dropped as an unknown forward-compat type. */
export const CLIENT_MESSAGE_TYPES: ReadonlySet<string> = discriminatorValues(ClientMessageSchema);

/** Client→server text messages (binary frames carry raw PCM16 audio). */
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ─── Host mode ───────────────────────────────────────────────────────────────

/**
 * Host-provided agent configuration for a host-mode connection: the caller
 * (e.g. a tau2 harness) supplies the system prompt, optional greeting, and
 * tool schemas for a single session instead of using a deployed agent.
 *
 * Validated standalone rather than as a `ClientMessageSchema` member — the
 * host-mode handshake consumes this message *before* `wireSessionSocket`
 * attaches, so it must never reach `dispatchMessage`/`ClientMessageSchema`.
 * See HOST_MODE_CONTRACT.md §§3-5.
 */
export const HostConfigSchema = z.object({
  systemPrompt: z.string().min(1),
  greeting: z.string().optional(),
  tools: z.array(ToolSchemaSchema),
});

/** Host-provided agent configuration for a host-mode connection. */
export type HostConfig = z.infer<typeof HostConfigSchema>;

/**
 * The host-mode handshake frame: the first inbound message on a host-mode
 * WebSocket connection, carrying the {@link HostConfigSchema} payload.
 *
 * The tau2 client sends a single `config` frame that also carries the audio
 * negotiation fields (`audioFormat`/`sampleRate`/`ttsSampleRate`) alongside
 * `host`; they are captured here (optional) so the host-mode handshake can
 * honor the client's requested sample rates instead of discarding them.
 */
export const HostConfigMessageSchema = z.object({
  type: z.literal("config"),
  host: HostConfigSchema,
  audioFormat: z.enum(["pcm16"]).optional(),
  sampleRate: z.number().int().positive().optional(),
  ttsSampleRate: z.number().int().positive().optional(),
});

/** The host-mode handshake frame. */
export type HostConfigMessage = z.infer<typeof HostConfigMessageSchema>;

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
