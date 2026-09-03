// Copyright 2026 the AAI authors. MIT license.
/**
 * The session EVENT vocabulary: what the server tells the world happened.
 *
 * ## Events and commands are different things, and they used to share a union
 *
 * One discriminated union carried both directions with one shape, so `cancel`
 * (a client asking for something) sat beside `reply.completed` (the server
 * reporting something that already happened) with nothing but the name to tell
 * them apart. They are separated now — commands live in `protocol-commands.ts`
 * — and the split is what lets everything in THIS module be retained, indexed
 * and replayed: a log of requests is not a log of facts, and only the second is
 * meaningful to a reader arriving late.
 *
 * ## Every event is `noun.verb-past`, and that is a decision about API
 *
 * The old names were a mix of tenses and shapes (`reply_done` beside bare nouns
 * like `config`, `error` and `agent_state`). Renaming was cheap for exactly as
 * long as these names were internal wiring; the hook surface makes them
 * AUTHOR-VISIBLE — an author writes `events: { "reply.completed"(e) {} }` — so
 * this was the last moment a rename cost nothing.
 *
 * ## The envelope is REQUIRED, and it is stamped once
 *
 * {@link SessionEventMeta} is minted when the event is written and stored with
 * it, so the same `meta.id` comes back from a cursor reconnect, a rewind to
 * index 0, and a replay of a finished session. Emitters therefore pass a
 * {@link SessionEventBody} and the session's emitter stamps it — a required
 * field on 40-odd call sites would be 40 chances to mint a second id for one
 * event, which is the one thing that would make the id useless.
 *
 * Note what the envelope deliberately does NOT carry: a step or turn
 * COORDINATE. eve nests session → turn → step and gives every event
 * `turnId`/`stepIndex`, which is what makes its retry semantics expressible.
 * A voice reply has a `replyId` the transport already knows and steps that are
 * counted but not addressable, so there is nothing honest to put there yet —
 * and a field that is sometimes meaningful is worse than one that is absent.
 *
 * ## Audio is NOT in here
 *
 * A session carries 384 kbps down and 256 kbps up of uncompressed PCM, and
 * audio frames are BINARY on the same socket. `audio.completed` is a control
 * event about audio, not audio; the samples never enter this vocabulary and so
 * never enter the retained stream. That split has to be explicit, because
 * "every event is durable" is otherwise the natural reading of a durable event
 * stream and it would mean minutes of PCM per call in the tenant's Postgres.
 *
 * @module
 */

import { z } from "zod";

import {
  DEFAULT_MAX_HISTORY,
  MAX_AUDIO_SAMPLE_RATE,
  MAX_CLIENT_EVENT_NAME_LENGTH,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TRANSCRIPT_CHARS,
} from "./constants.ts";

/**
 * The prefix every session-event id carries, so an id names its own kind.
 *
 * `evt_` then a ULID — see {@link SessionEventMeta} and its `id` field for what
 * the id is and is not good for. The link names the TYPE rather than the field
 * because the type is `z.infer`red, so TypeDoc documents it as an anonymous
 * object and has no anchor to point a member link at.
 */
export const EVENT_ID_PREFIX = "evt_";

/** Zod schema for {@link SessionEventMeta}. */
export const SessionEventMetaSchema = z.object({
  /**
   * This event's identity, for the whole of its life: `evt_` + a ULID, minted
   * once when the event is written and stored with it.
   *
   * **It is the key for ingesting a stream idempotently, and it is not a
   * cursor.** Three limits come with it, each inherited deliberately rather
   * than rediscovered:
   *
   * - Ids are TIME-ordered, not totally ordered — a session resumed onto a
   *   replacement process mints from a different clock — so `id > $cursor`
   *   drops events. {@link SessionEventEnvelope.index} is the only
   *   authoritative cursor.
   * - It deduplicates DELIVERY, never EXECUTION: retried work re-emits under
   *   fresh ids, so a hook with a non-idempotent side effect keys on the work's
   *   own coordinates (the session, the reply) instead.
   * - It identifies an EVENT, not an intent: one failure legitimately produces
   *   several events, so deduplicating by content would drop real data.
   */
  id: z.string().startsWith(EVENT_ID_PREFIX),
  /** When the event was stamped — epoch milliseconds, the writer's clock. */
  at: z.number().int().nonnegative(),
});

/** The envelope every session event carries. */
export type SessionEventMeta = z.infer<typeof SessionEventMetaSchema>;

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
 * @remarks
 * The field a client renders its error banner from (`error.reported.code`, and
 * `SessionError.code` in `@alexkroman1/aai-ui`). Eight values, by where the
 * failure came from:
 *
 * - `stt` — speech-to-text: the provider refused the connection, or its stream
 *   failed mid-utterance.
 * - `llm` — the model call for a reply failed. In pipeline mode the caller also
 *   hears `errorPhrase`, so the turn is handed back rather than going silent.
 * - `tts` — synthesis failed, which is the one the caller cannot hear.
 * - `tool` — a tool threw and the failure could not be given to the model.
 * - `protocol` — a frame that does not parse, or one sent in a state that has
 *   no answer for it.
 * - `connection` — the session's own link, or a provider's, went away.
 * - `audio` — the audio path: a rate the transport cannot honour, a decode.
 * - `internal` — anything the runtime could not classify.
 *
 * **Severity is `fatal`, not the code**, and the two are independent: any of
 * these can arrive on a session that continues. `fatal: false` means surface
 * the message and keep the session interactive. It is REQUIRED: a fatal frame
 * is not a banner — `aai-ui` answers one by releasing the microphone and ending
 * the call — so every emitter states which it means rather than inheriting a
 * default that takes the whole session down.
 *
 * @public
 */
export type SessionErrorCode = z.infer<typeof SessionErrorCodeSchema>;

// ─── The events ────────────────────────────────────────────────────────────

/** Helper: an event carrying nothing but its own name and envelope. */
const ev = <T extends string>(t: T) =>
  z.object({ type: z.literal(t), meta: SessionEventMetaSchema });

/** Zod schema for {@link SessionEvent}. */
/**
 * One tool call as a RESUME reports it — see `history.restored`.
 *
 * Its own schema because the host builds these (`historyFromEvents`) and the
 * client reads them, so the shape wants one name on both sides. It is deliberately
 * NOT `tool.called` plus `tool.completed`: those are two live events, and what a
 * restore sends is their settled JOIN.
 */
export const RestoredToolCallSchema = z.object({
  callId: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "done"]),
  result: z.string().max(MAX_TOOL_RESULT_CHARS).optional(),
  /** Index into the frame's own `messages`; `-1` for "before any message". */
  afterMessageIndex: z.number().int().min(-1),
});

/** One tool call as a resume reports it. @internal */
export type RestoredToolCall = z.infer<typeof RestoredToolCallSchema>;

/**
 * Zod schema for {@link AgentTranscriptRecovery}.
 * @public
 */
export const AgentTranscriptRecoverySchema = z.enum(["turn-failed", "session-failed"]);

/**
 * Why the TRANSPORT spoke a committed transcript on its own behalf.
 *
 * @remarks
 * Absent — the overwhelming majority — means the agent's own words: an ordinary
 * reply, or the declared greeting. Present names one of the two failure phrases
 * a pipeline session speaks when the model cannot:
 *
 * - `turn-failed` — `errorPhrase`, after an LLM turn failed, so a provider
 *   outage hands the conversation back instead of going quiet.
 * - `session-failed` — `startFailurePhrase`, when a provider failed to open and
 *   there is no conversation to have.
 *
 * **A recovery utterance is SPOKEN but never RECORDED, and this field is the
 * only thing on the wire that says so.** Both phrases reach the caller's ears
 * and the caller's caption — that is deliberate, the UI matching the audio — and
 * both are kept out of history and out of `ctx.messages` for a measured reason:
 * teaching the model that its own replies open with apologies is how it starts
 * producing them unprompted. Without the field the two rules composed into the
 * outcome both forbid, because a reader of the retained stream could not tell a
 * failure phrase from a reply: the phrase was excluded from history for a whole
 * call and then seeded back into it by the first reconnect (and into
 * `ctx.messages` immediately, by the live event dispatch).
 *
 * So a reader that reconstructs the CONVERSATION must skip an event carrying
 * this; a reader that renders the TRANSCRIPT must not. An older reader that
 * knows nothing of the field keeps its previous behaviour on both counts —
 * unknown keys are stripped, never rejected.
 *
 * @public
 */
export type AgentTranscriptRecovery = z.infer<typeof AgentTranscriptRecoverySchema>;

export const SessionEventSchema = z.discriminatedUnion("type", [
  /**
   * The handshake: audio negotiation plus the session's own id.
   *
   * First on every connection and sent at zero RTT, which is what makes it the
   * one frame a DYING session cannot produce — see aai-ui's fatal latch.
   */
  z.object({
    type: z.literal("session.configured"),
    meta: SessionEventMetaSchema,
    audioFormat: z.string(),
    // Bounded: these numbers feed client-side allocations (the playback
    // worklet's rate*60 ring buffer), so an unbounded server value would be
    // an allocation-size lever against the client.
    sampleRate: z.number().int().positive().max(MAX_AUDIO_SAMPLE_RATE),
    ttsSampleRate: z.number().int().positive().max(MAX_AUDIO_SAMPLE_RATE),
    /**
     * Session ID for this connection. Clients reconnect with `?sessionId=<id>`
     * to resume, and read the retained event stream by the same id.
     */
    sessionId: z.string().optional(),
  }),
  /**
   * All of this turn's TTS audio has been sent. A turn BOUNDARY, so the pacer
   * queues it behind pending audio — an early one truncates the reply, because
   * the playback worklet takes it as "this is all there is".
   */
  ev("audio.completed"),
  /**
   * The agent is YIELDING the floor — on both transports, which is the whole
   * reason it is held back in pipeline mode rather than fired on the first STT
   * partial. See "`speech.started` means the agent is yielding" in the SDK
   * guide: 53% of the events a client acted on were not interruptions.
   */
  ev("speech.started"),
  ev("speech.stopped"),
  /**
   * Interim (in-progress) user transcript — live captions while the user is
   * still speaking. Pipeline mode forwards STT partials here; the committed
   * turn still arrives as `user-transcript.committed`.
   */
  z.object({
    type: z.literal("user-transcript.updated"),
    meta: SessionEventMetaSchema,
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
  /** The caller's committed turn — this is the one that enters history. */
  z.object({
    type: z.literal("user-transcript.committed"),
    meta: SessionEventMetaSchema,
    text: z.string().max(MAX_TRANSCRIPT_CHARS),
  }),
  /**
   * The current reply's transcript so far — a **full-replacement snapshot**, and
   * the last one before `reply.completed` is the whole reply. Pipeline mode sends
   * one as each piece of text reaches TTS, so captions track the speech; S2S sends
   * a single one per reply, when its provider reports the finished transcript.
   * Either way a client renders the latest text for the reply in progress and
   * commits it on `reply.completed`/`reply.cancelled` — never appending them as
   * separate turns.
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
    type: z.literal("agent-transcript.updated"),
    meta: SessionEventMetaSchema,
    text: z.string().max(MAX_TRANSCRIPT_CHARS),
  }),
  /**
   * The reply's final text, as the RECORD keeps it — the assistant turn that
   * entered history.
   *
   * Its own event, where the old protocol reused one name for the interim
   * snapshots and the final alike. A client renders it exactly like an
   * `agent-transcript.updated`, so nothing about the caption changes; what needs
   * the distinction is the STREAM, because reconstructing a conversation from
   * the log is otherwise guesswork — an interim snapshot and a committed reply
   * are indistinguishable by shape, and an INTERRUPTED reply's last snapshot is
   * not a record of anything (see "History records what was HEARD" in the SDK
   * guide: a reply cut before anything was audible records nothing at all).
   *
   * So the rule is: this event fires once per reply that is recorded, and never
   * for one that was interrupted. That makes the log's assistant turns exactly
   * the session's own, rather than a re-derivation that can disagree with it.
   *
   * ...with ONE exception, which is why `recovery` exists: the transport also
   * speaks for itself when a turn or a session FAILS, and the caller heard those
   * words, so they belong in the caption. See {@link AgentTranscriptRecovery}.
   */
  z.object({
    type: z.literal("agent-transcript.committed"),
    meta: SessionEventMetaSchema,
    text: z.string().max(MAX_TRANSCRIPT_CHARS),
    recovery: AgentTranscriptRecoverySchema.optional(),
  }),
  z.object({
    type: z.literal("tool.called"),
    meta: SessionEventMetaSchema,
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool.completed"),
    meta: SessionEventMetaSchema,
    toolCallId: z.string(),
    result: z.string().max(MAX_TOOL_RESULT_CHARS),
  }),
  /** The reply finished on its own terms. */
  ev("reply.completed"),
  /** The reply was abandoned — a barge-in, a client cancel, or a reset. */
  ev("reply.cancelled"),
  /**
   * The conversation was discarded and a new one begins — which is why the
   * transports GREET on it (see "A `reset` starts a conversation" in the SDK
   * guide).
   */
  ev("session.reset"),
  /**
   * Silence outlasted `idleTimeoutMs`. Informational: the server closes the
   * socket itself, because the event alone retires nothing.
   */
  ev("session.timed-out"),
  z.object({
    type: z.literal("error.reported"),
    meta: SessionEventMetaSchema,
    code: SessionErrorCodeSchema,
    message: z.string().max(MAX_ERROR_MESSAGE_CHARS),
    /**
     * Whether the session is over. False for turn-level errors it survives
     * (e.g. a failed one-shot transcription): the client should surface the
     * message but keep the session interactive.
     *
     * REQUIRED, because the two readings are not equally safe — `aai-ui`
     * answers a fatal frame by releasing the microphone and ending the call,
     * so an emitter that leaves it to a default takes the whole session down
     * for a failure one turn survived.
     */
    fatal: z.boolean(),
  }),
  /** An event the AGENT named, via `ctx.send`. */
  z.object({
    type: z.literal("custom.emitted"),
    meta: SessionEventMetaSchema,
    event: z.string().min(1).max(MAX_CLIENT_EVENT_NAME_LENGTH),
    data: z.unknown(),
  }),
  /**
   * The agent's projected session state (see `AgentDef.syncState`).
   *
   * Its own frame rather than a `custom.emitted` for two reasons: the client
   * keeps the LATEST value rather than appending to an event log, so a
   * component mounting late still sees current state; and a reserved type
   * cannot collide with an event name the author chose.
   */
  z.object({
    type: z.literal("state.updated"),
    meta: SessionEventMetaSchema,
    state: z.unknown(),
  }),
  /**
   * The conversation this session already had, sent when a RESUME restores one.
   *
   * **The frame that closes a hand-off neither side was making.** A reconnecting
   * client stopped replaying its own history on the stated grounds that "the
   * server restores the conversation from its own retained event stream now" —
   * and the server does, into the LLM's context (`restoreHistory` →
   * `seedHistory`). Nothing put it on the WIRE. So a page reload resumed
   * correctly by every server-side measure, with the greeting suppressed because
   * the resume was real, and rendered an EMPTY transcript: the agent remembered
   * the conversation and the person looking at it could not see it. Both halves
   * were individually right, which is why nothing failed loudly.
   *
   * Shaped like `state.updated` above rather than like a transcript event: the
   * client REPLACES its list from this, so the server stays authoritative and a
   * frame delivered twice (a second reconnect) cannot double the conversation.
   * That is also why it carries no ids — the client owns `ChatMessage.id`, which
   * is a render key assigned at append time, and minting them here would put two
   * numbering schemes on one list.
   *
   * NOT recorded in the retained stream, and that is load-bearing: it is sent
   * through the sink with a stamp of its own (`stampSessionEvent`), because
   * emitting it would append the whole restored history to the log it was just
   * read from — doubling the log on every resume, unboundedly.
   */
  z.object({
    type: z.literal("history.restored"),
    meta: SessionEventMetaSchema,
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().max(MAX_TRANSCRIPT_CHARS),
        }),
      )
      .max(DEFAULT_MAX_HISTORY),
    /**
     * The tool calls interleaved through those messages.
     *
     * Anchored by INDEX into `messages` above, never by id: the client mints its
     * own render keys, so an id here would be a second numbering scheme over one
     * list. `-1` means "before any message", the same sentinel the live path
     * uses when a tool call arrives with no message yet.
     *
     * Without these a resumed conversation comes back as plain dialogue with
     * every tool row missing, which reads as the agent having done less than it
     * did. A call with no completion stays `pending` — it may really have been in
     * flight when the process died.
     */
    toolCalls: z.array(RestoredToolCallSchema).max(DEFAULT_MAX_HISTORY),
  }),
]);

/**
 * One **server→client** session event, envelope included: a fact the session
 * reports, in the shape it takes on the wire and in the retained stream.
 *
 * This is what a hook handler receives and what a client parses. Host code
 * EMITS a {@link SessionEventBody} and the session's emitter stamps the
 * envelope — see the module doc.
 */
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/** `Omit` that distributes over a union, so each member keeps its own `type`. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A session event as its EMITTER writes it — everything but the envelope,
 * which the session stamps exactly once.
 */
export type SessionEventBody = DistributiveOmit<SessionEvent, "meta">;

/** Every event name, as a set — for `lenientParse`'s known-types argument. */
export const SESSION_EVENT_TYPES: ReadonlySet<string> = new Set(
  SessionEventSchema.options.map((option) => option.shape.type.value),
);
