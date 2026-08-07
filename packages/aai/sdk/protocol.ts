// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket wire-format types shared by server and client.
 *
 * This is the published wire contract (`@alexkroman1/aai/protocol`) for
 * building custom clients or servers that speak the session protocol —
 * aai-ui's browser session is built on it.
 *
 * @module protocol
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
import { capToolResult } from "./utils.ts";

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
 * is silently swallowed as if it were a forward-compat unknown type. When
 * parsing client→server messages, pass {@link CLIENT_MESSAGE_TYPES} as
 * `knownTypes`.
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
    /**
     * The STT service's confidence that the user's turn has ENDED as of this
     * interim, 0..1, when the provider reports one (AssemblyAI's
     * `end_of_turn_confidence`). Absent means "no opinion", never zero.
     *
     * Carried on the wire so an endpointing policy can be MEASURED before it
     * is built: pairing each interim's confidence and text against the final
     * that follows gives the lead time a speculative turn-start would buy and
     * the rate at which the transcript would still have been correct. Nothing
     * acts on it.
     */
    eotConfidence: z.number().min(0).max(1).optional(),
  }),
  /**
   * The current reply's transcript so far — a **full-replacement snapshot**, and
   * the last one before `reply_done` is the whole reply. Pipeline mode sends one
   * as each piece of text reaches TTS, so captions track the speech; S2S sends a
   * single one per reply, when its provider reports the finished transcript.
   * Either way a client renders the latest text for the reply in progress and
   * commits it on `reply_done`/`cancelled` — never appending them as separate
   * turns.
   *
   * Snapshot, NOT an append-only or monotonically growing string: a pipeline
   * reply's final snapshot can be SHORTER than the one before it, and can differ
   * in the middle rather than only at the end. The interim snapshots are built
   * from everything handed to TTS, which includes the dead-air cover fillers
   * the caller hears; the reply's closing snapshot is the model's own words,
   * with that filler removed — so "I'm checking on this. Thanks, I found your
   * account. I'm still on it. Here it is." is followed by "Thanks, I found your
   * account. Here it is.". That is deliberate: the
   * committed message should read as dialogue, while the live caption should
   * match the audio. A client that diffs against the previous snapshot, renders
   * incrementally, or assumes a common prefix will corrupt — replace the text.
   */
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
  /**
   * The agent's projected session state (see `AgentDef.syncState`).
   *
   * Its own frame rather than a `custom_event` for two reasons: the client
   * keeps the LATEST value rather than appending to an event log, so a
   * component mounting late still sees current state; and a reserved type
   * cannot collide with an event name the author chose.
   */
  z.object({
    type: z.literal("agent_state"),
    state: z.unknown(),
  }),
]);

/**
 * Discriminated union of all **server→client** session events. Despite the
 * shared prefix, this is the opposite direction from {@link ClientMessage}
 * (client→server): "client" here means events delivered *to* the client.
 */
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
  /**
   * Close the underlying connection (best-effort, idempotent). Used when the
   * server retires a session out from under a connected client — a resume
   * takeover, or a sandbox teardown — so the client gets a real close to
   * react to instead of a socket that silently stops answering.
   */
  close?(reason?: string): void;
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
    /**
     * Truncated rather than rejected. A `.max()` here made an oversized result
     * fail validation, and a failed client message is *dropped* — so the relay
     * call it was answering never settled and hung to
     * `DEFAULT_RELAY_TOOL_TIMEOUT_MS`, presenting as a stuck tool rather than as
     * data that didn't fit. The transform bounds host memory the same way while
     * letting the turn continue on the part that fits (marked `[truncated]`).
     */
    result: z.string().transform(capToolResult),
    error: z.string().optional(),
  }),
]);

/** The set of recognised client→server message `type` values — pass to
 *  `lenientParse` so a known-but-invalid message warns instead of being
 *  silently dropped as an unknown forward-compat type. */
export const CLIENT_MESSAGE_TYPES: ReadonlySet<string> = discriminatorValues(ClientMessageSchema);

/**
 * **Client→server** text messages (binary frames carry raw PCM16 audio).
 * Note the direction: the similarly named {@link ClientEvent} flows the other
 * way (server→client).
 */
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ─── Host mode ───────────────────────────────────────────────────────────────

/**
 * Host-provided agent configuration for a host-mode connection: the caller
 * (e.g. an external evaluation harness) supplies the system prompt, optional
 * greeting, and tool schemas for a single session instead of using a deployed
 * agent.
 *
 * Validated standalone rather than as a `ClientMessageSchema` member — the
 * host-mode handshake consumes this message *before* `wireSessionSocket`
 * attaches, so it must never reach `dispatchMessage`/`ClientMessageSchema`.
 */
export const HostConfigSchema = z.object({
  systemPrompt: z.string().min(1),
  greeting: z.string().optional(),
  tools: z.array(ToolSchemaSchema),
  /**
   * Contextual biasing for the pipeline's STT stage (AssemblyAI's streaming
   * `prompt`). The client owns the task's vocabulary — spelled-out order IDs,
   * product codes, passport numbers — and steering the LLM alone leaves those
   * identifiers transcribed unbiased, where a formatted final turn can revise
   * a spelled code out of the transcript entirely. Omit it to keep whatever
   * the deployed agent configures.
   *
   * Honoured by BOTH transports: the pipeline passes it to its STT stage, and
   * S2S sends it as `input.transcription_prompt` (trimmed to that field's
   * documented 1750-char cap). It used to be pipeline-only, which made it a
   * silent no-op for every S2S agent rather than a documented limitation.
   */
  sttPrompt: z.string().optional(),
  /**
   * Provider credentials the session should run on, keyed by env var name
   * (`{ ASSEMBLYAI_API_KEY: "…" }`) — the caller brings its own key instead of
   * spending the operator's.
   *
   * This is what makes a host server multi-tenant without handing every
   * connecting client the operator's credentials: the server can hold none at
   * all and let each session pay for itself. Keys supplied here WIN over the
   * server's own env for that one connection; a client can only substitute a
   * credential it already owns, never read the operator's.
   *
   * Only names in `ALL_PROVIDER_ENV_VARS` are accepted, and the handshake is
   * rejected outright when an unlisted one appears — this record is merged
   * into the per-connection runtime's env, so an unbounded one would let a
   * client set `DATABASE_URL` and point `ctx.db` at a server it controls.
   */
  credentials: z.record(z.string(), z.string().min(1)).optional(),
  /**
   * How much agent audio the host may keep in flight, in ms — the client
   * declaring its own playback behaviour, because it is the only party that
   * knows it.
   *
   * Omitted means real-time pacing (`CLIENT_AUDIO_LEAD_MS`), which is right for
   * anything that plays audio at one second per second. `null` disables pacing
   * entirely, for a client whose timeline runs FASTER than the wall clock (a
   * simulation stepping per processed tick); metering to the wall clock starves
   * that client, and it does so invisibly.
   *
   * The default is paced because the opposite default was measured to be
   * destructive for the far more common case: a client that drains at 1x. In
   * S2S mode the service synthesises a whole reply server-side and it arrives
   * in one burst, so unpaced relay handed the tau2 harness a backlog that grew
   * to MINUTES — and that harness discards its buffered audio on barge-in, so
   * 36% of all agent speech was destroyed unheard (p99 181s per barge-in,
   * against 15s max on the pipeline transport, whose per-sentence TTS flush
   * paces it inherently). Pacing keeps the backlog on this side, where
   * `PacedAudioSink.clear()` drops it on barge-in instead.
   */
  audioLeadMs: z.union([z.number().positive(), z.null()]).optional(),
});

/** Host-provided agent configuration for a host-mode connection. */
export type HostConfig = z.infer<typeof HostConfigSchema>;

/**
 * The host-mode handshake frame: the first inbound message on a host-mode
 * WebSocket connection, carrying the {@link HostConfigSchema} payload.
 *
 * A host-mode client sends a single `config` frame that also carries the
 * audio negotiation fields (`audioFormat`/`sampleRate`/`ttsSampleRate`)
 * alongside `host`; they are captured here (optional) so the host-mode
 * handshake can honor the client's requested sample rates instead of
 * discarding them.
 */
export const HostConfigMessageSchema = z.object({
  type: z.literal("config"),
  host: HostConfigSchema,
  audioFormat: z.enum(["pcm16"]).optional(),
  sampleRate: z.number().int().positive().optional(),
  ttsSampleRate: z.number().int().positive().optional(),
});

// ─── Ready config builder ───────────────────────────────────────────────────

/**
 * Build the protocol-level session config (the `config` frame's audio fields)
 * from the session's input/output sample rates — used by every session mode,
 * pipeline and S2S alike.
 */
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
