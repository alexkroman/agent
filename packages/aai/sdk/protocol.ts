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
import { MAX_AUDIO_SAMPLE_RATE } from "./constants.ts";
import type { SessionEvent } from "./protocol-events.ts";

// The pre-connection client-config endpoint's wire format is part of the
// same protocol surface — re-exported so clients import one subpath.
export {
  buildClientConfig,
  CLIENT_CONFIG_METHODS,
  CLIENT_CONFIG_PATH,
  type ClientConfigResponse,
  ClientConfigResponseSchema,
} from "./client-config.ts";

/**
 * The two halves of the wire vocabulary, re-exported so `/protocol` stays one
 * import for a client. They are separate MODULES because the split between them
 * is load-bearing — see `protocol-events.ts` — and separate files because this
 * one is at the file-length cap.
 */
export {
  SESSION_COMMAND_TYPES,
  type SessionCommand,
  SessionCommandSchema,
} from "./protocol-commands.ts";
export {
  EVENT_ID_PREFIX,
  type RestoredToolCall,
  RestoredToolCallSchema,
  SESSION_EVENT_TYPES,
  type SessionErrorCode,
  SessionErrorCodeSchema,
  type SessionEvent,
  type SessionEventBody,
  type SessionEventMeta,
  SessionEventMetaSchema,
  SessionEventSchema,
} from "./protocol-events.ts";

/**
 * Audio codec identifier used in the wire protocol.
 *
 * All audio frames are 16-bit signed PCM, little-endian, mono.
 */
const AUDIO_FORMAT = "pcm16";

/**
 * Minimal envelope schema for two-phase message parsing.
 *
 * When a strict schema (SessionEventSchema / SessionCommandSchema) rejects a
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
 * parsing client→server messages, pass {@link SESSION_COMMAND_TYPES} as
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

/**
 * Typed interface for pushing session events to a connected client.
 *
 * Events send JSON text frames; audio chunks (`playAudioChunk`) send raw PCM16
 * binary frames. There is no `playAudioDone` — the turn's `audio.completed` is
 * an ordinary event now, and the sink orders it behind held audio by type. That
 * is what let it join the retained stream: a method on the sink was a frame no
 * event log could see.
 */
export interface ClientSink {
  /** True when the underlying connection is open and will accept calls. */
  readonly open: boolean;
  /**
   * Push a session event (JSON text frame) to the client.
   *
   * Takes an ALREADY-STAMPED {@link SessionEvent}: the envelope is minted once,
   * by the session's emitter, which is also what appends the event to the
   * retained stream. A sink that stamped its own would mint a second id for an
   * event the stream had already recorded under another.
   */
  event(e: SessionEvent): void;
  /** Send a single PCM16 audio chunk (raw binary frame) to the client. */
  playAudioChunk(chunk: Uint8Array): void;
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

// ─── Host mode ───────────────────────────────────────────────────────────────

/**
 * Host-provided agent configuration for a host-mode connection: the caller
 * (e.g. an external evaluation harness) supplies the system prompt, optional
 * greeting, and tool schemas for a single session instead of using a deployed
 * agent.
 *
 * Validated standalone rather than as a `SessionCommandSchema` member — the
 * host-mode handshake consumes this message *before* `wireSessionSocket`
 * attaches, so it must never reach `dispatchMessage`/`SessionCommandSchema`.
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
  /**
   * Bounded by `MAX_AUDIO_SAMPLE_RATE`, the same cap `session.configured`
   * carries — because these two BECOME that frame's fields.
   *
   * Unbounded here, the server accepted a rate it would then emit and its own
   * outbound schema reject. Measured against `aai dev` with host mode on:
   * `sampleRate: 2 ** 31` was accepted and echoed back in `session.configured`,
   * a frame that fails `SessionEventSchema`. That schema's own comment gives
   * the reason for its cap — these numbers feed client-side allocations — and
   * this is where the number a `?host=1` client supplies enters.
   *
   * `assertHostRatesSupported` bounds them too, but only for an AssemblyAI S2S
   * agent, which must be exactly 16 kHz; a pipeline agent had no bound at all.
   */
  sampleRate: z.number().int().positive().max(MAX_AUDIO_SAMPLE_RATE).optional(),
  ttsSampleRate: z.number().int().positive().max(MAX_AUDIO_SAMPLE_RATE).optional(),
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
