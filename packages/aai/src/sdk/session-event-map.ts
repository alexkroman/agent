// Copyright 2026 the AAI authors. MIT license.
/**
 * The session event vocabulary as a MAP — one entry per event name — and every
 * type the rest of the SDK, the runtime and the specs read events through.
 *
 * ## Why a map, and why here
 *
 * Every consumer of the vocabulary used to restate it. `agent({ events })` keyed
 * its handlers off `SessionEvent["type"]`, a dialog's `@` names were a template
 * literal over the same union, `aai-runtime` spelled the fourteen events a
 * transport may report out as a literal list, and specs narrowed with
 * `Extract<SessionEvent, { type: "tool.called" }>` wherever they needed one
 * member. Worse, the union itself was exported only from the non-authoring
 * `/protocol` subpath, so NO capability contract owned it: its body was hashed
 * in full by every capability that reached it, and one new event
 * (`userTurn.exceeded`, `metrics.collected`) bumped `aai:agent`, `aai:dialog`,
 * `aai:testing` and `aai-runtime:session` at once.
 *
 * Now {@link SessionEventMap} is declared here once, and every other name is a
 * lookup into the map: `SessionEvent<"tool.called">` is one member,
 * `SessionEventType` the key set, `SessionEventBody<K>` a member without its
 * envelope. The whole family is owned by the `aai:events` capability, so a new
 * event is ONE classification.
 *
 * ## Written out, not inferred from the schema
 *
 * The map used to be `z.infer` over `SessionEventSchema`, which put zod's
 * internals (`z.ZodObject<…, z.core.$strip>`) into the published contract: a
 * zod upgrade moved the hash, and nothing an author reads changed. The map is
 * the SDK's own declaration now; the schema (`/protocol`) is typed against it,
 * and `session-event-map.test.ts` holds the schema's output assignable to it
 * and the two key sets equal, so neither can drift.
 *
 * Every closed set an author RECEIVES here is open (`| (string & {})`): a new
 * error code, failover stage or recovery reason is a new event FIELD VALUE, and
 * a reader's exhaustive `switch` should not stop compiling because of one.
 *
 * ## The map is an interface, so it can be augmented
 *
 * `interface SessionEventMap` rather than a type alias: a host that ships an
 * event of its own can declare it with module augmentation and have
 * `SessionEvent`, `SessionEventType` and the handler map pick it up. Only the
 * TYPES widen — the schema still validates the wire — so an augmented event is
 * the augmenting package's to emit and to parse.
 *
 * @module
 */

import type { SessionEventMeta } from "./protocol-event-meta.ts";

/**
 * What a session reports when a SUBSYSTEM fails — the `code` of an
 * `error.reported` event. Open: a new subsystem's code is not a break.
 *
 * @public
 */
export type SessionErrorCode =
  | "stt"
  | "llm"
  | "tts"
  | "tool"
  | "protocol"
  | "connection"
  | "audio"
  | "internal"
  | (string & {});

/**
 * Why the transport spoke a reply ITSELF — `agentTranscript.committed`'s
 * `recovery`: `"turn-failed"` (one turn failed and the session lives on) or
 * `"session-failed"` (the last thing said before the session ends).
 *
 * @public
 */
export type AgentTranscriptRecovery = "turn-failed" | "session-failed" | (string & {});

/**
 * One tool call a resumed conversation carries back — `history.restored`'s
 * `toolCalls`.
 *
 * @sealed
 * @public
 */
export interface RestoredToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** `"pending"` when no completion was recorded — it may have been in flight. */
  status: "pending" | "done";
  result?: string | undefined;
  /** Index into `messages` the call follows; `-1` means before any message. */
  afterMessageIndex: number;
}

/**
 * Every session event, keyed by its `type`.
 *
 * Read one member with `SessionEvent<"tool.called">`, never with
 * `Extract<SessionEvent, { type: … }>`: the lookup fails to compile on a
 * misspelled name, where the `Extract` silently resolves to `never`.
 *
 * @sealed
 * @public
 */
export interface SessionEventMap {
  /**
   * The handshake: audio negotiation plus the session's own id. First on every
   * connection and sent at zero RTT.
   */
  "session.configured": {
    type: "session.configured";
    meta: SessionEventMeta;
    audioFormat: string;
    sampleRate: number;
    ttsSampleRate: number;
    /** Reconnect with `?sessionId=<id>` to resume; the retained stream is read by it too. */
    sessionId: string;
  };
  /** All of this turn's TTS audio has been sent — a turn BOUNDARY. */
  "audio.completed": { type: "audio.completed"; meta: SessionEventMeta };
  /** The agent is YIELDING the floor (held back in pipeline mode until it really is). */
  "speech.started": { type: "speech.started"; meta: SessionEventMeta };
  "speech.stopped": { type: "speech.stopped"; meta: SessionEventMeta };
  /** Interim user transcript — live captions while the user is still speaking. */
  "userTranscript.updated": {
    type: "userTranscript.updated";
    meta: SessionEventMeta;
    text: string;
    /**
     * The STT service's confidence, 0..1, that the user's turn has ENDED as of
     * this interim, when the provider reports one. Absent means "no opinion".
     */
    eotConfidence?: number | undefined;
  };
  /** The caller's committed turn — the one that enters history. */
  "userTranscript.committed": {
    type: "userTranscript.committed";
    meta: SessionEventMeta;
    text: string;
  };
  /**
   * The current reply's transcript so far — a FULL-REPLACEMENT snapshot, which
   * may be shorter than the one before it. Replace the text; never diff or append.
   */
  "agentTranscript.updated": {
    type: "agentTranscript.updated";
    meta: SessionEventMeta;
    text: string;
  };
  /**
   * The reply's final text as the RECORD keeps it. Fires once per recorded
   * reply, never for an interrupted one — except when `recovery` or
   * `recorded: false` says otherwise.
   */
  "agentTranscript.committed": {
    type: "agentTranscript.committed";
    meta: SessionEventMeta;
    text: string;
    recovery?: AgentTranscriptRecovery | undefined;
    recorded?: false | undefined;
  };
  "tool.called": {
    type: "tool.called";
    meta: SessionEventMeta;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  };
  "tool.completed": {
    type: "tool.completed";
    meta: SessionEventMeta;
    toolCallId: string;
    result: string;
  };
  /** The reply finished on its own terms. */
  "reply.completed": { type: "reply.completed"; meta: SessionEventMeta };
  /** The reply was abandoned — a barge-in, a client cancel, or a reset. */
  "reply.cancelled": { type: "reply.cancelled"; meta: SessionEventMeta };
  /** The conversation was discarded and a new one begins (the transports greet on it). */
  "session.reset": { type: "session.reset"; meta: SessionEventMeta };
  /** Silence outlasted `idleTimeoutMs`. Informational: the server closes the socket. */
  "session.timedOut": { type: "session.timedOut"; meta: SessionEventMeta };
  "error.reported": {
    type: "error.reported";
    meta: SessionEventMeta;
    code: SessionErrorCode;
    message: string;
    /** Whether the session is over. False for a turn-level error it survives. */
    fatal: boolean;
  };
  /** An event the AGENT named, via `ctx.send`. */
  "custom.emitted": {
    type: "custom.emitted";
    meta: SessionEventMeta;
    event: string;
    data: unknown;
  };
  /** The agent's projected session state (see `AgentDef.syncState`); keep the LATEST. */
  "state.updated": {
    type: "state.updated";
    meta: SessionEventMeta;
    state: Record<string, unknown>;
  };
  /** Cumulative model token usage for the session. */
  "usage.updated": {
    type: "usage.updated";
    meta: SessionEventMeta;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    steps: number;
  };
  /** A guardrail stopped a turn and `replacement` was said instead. */
  "guardrail.blocked": {
    type: "guardrail.blocked";
    meta: SessionEventMeta;
    direction: "input" | "output" | (string & {});
    replacement: string;
  };
  /** The caller's turn passed a `userTurnLimit`. */
  "userTurn.exceeded": {
    type: "userTurn.exceeded";
    meta: SessionEventMeta;
    limit: "words" | "duration" | (string & {});
    words: number;
    durationMs: number;
  };
  /** A `fallback([...])` stage switched provider. */
  "provider.failedOver": {
    type: "provider.failedOver";
    meta: SessionEventMeta;
    stage: "stt" | "llm" | "tts" | (string & {});
    from: string;
    to: string;
    reason: string;
  };
  /** What one reply cost, stage by stage. Durations are milliseconds. */
  "metrics.collected": {
    type: "metrics.collected";
    meta: SessionEventMeta;
    /** The reply was cut short; its stages are still reported. */
    interrupted: boolean;
    /** From the caller's committed turn to the reply's first audio. */
    latencyMs?: number | undefined;
    stt?: { endpointingMs?: number | undefined } | undefined;
    llm?:
      | {
          ttftMs?: number | undefined;
          durationMs: number;
          steps: number;
          inputTokens?: number | undefined;
          outputTokens?: number | undefined;
        }
      | undefined;
    tts?: { ttfbMs?: number | undefined; characters: number } | undefined;
  };
  /** The conversation a RESUME restored; the client REPLACES its list from it. */
  "history.restored": {
    type: "history.restored";
    meta: SessionEventMeta;
    messages: { role: "user" | "assistant"; content: string }[];
    toolCalls: RestoredToolCall[];
  };
}

/**
 * What a `"*"` handler receives: ANY event, by its envelope alone. Open on
 * purpose — a new event reaches a wildcard handler without a type change, and
 * a handler that wants a member's fields declares the per-name handler.
 *
 * @sealed
 * @public
 */
export interface AnySessionEvent {
  readonly type: string;
  readonly meta: SessionEventMeta;
}

/**
 * The agent's OWN custom events — what `ctx.send(event, data)` pushes to the
 * browser — keyed by event name, and EMPTY until the agent declares some.
 *
 * An interface so an agent can augment it, exactly like
 * {@link SessionEventMap}. Once a name is declared, `ctx.send` type-checks its
 * payload: a misspelled field or a wrong type is a compile error in the tool
 * that sends it, rather than a client handler that silently reads `undefined`.
 * A name nobody declared still sends `unknown`, so declaring one event never
 * obliges the agent to declare the rest.
 *
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * declare module "@alexkroman1/aai" {
 *   interface ClientEventMap {
 *     "order.progress": { done: number; total: number };
 *   }
 * }
 *
 * export default tool({
 *   description: "Ship the order",
 *   inputSchema: z.object({}),
 *   execute: (_args, ctx) => {
 *     ctx.send("order.progress", { done: 1, total: 3 });
 *     return { ok: true };
 *   },
 * });
 * ```
 *
 * The payload is typed on the SENDING side only: on the wire it is still a
 * `custom.emitted` frame whose `data` the schema admits as any JSON value.
 *
 * @input
 * @public
 */
// biome-ignore lint/suspicious/noEmptyInterface: empty on purpose — the declaration authors augment.
export interface ClientEventMap {}

/**
 * What `ctx.send` is: push one custom event to the connected browser client,
 * typed by {@link ClientEventMap}.
 *
 * A name declared in the map must be sent with its declared payload; any other
 * name takes `unknown`. ONE conditional signature rather than a typed overload
 * in front of a `(string, unknown)` fallback, deliberately: with overloads, a
 * DECLARED name sent with the wrong payload fails the first signature and
 * silently resolves against the fallback, so the declaration would type
 * nothing. Any `(event: string, data: unknown) => void` is one of these, which
 * is how the runtime and the test doubles implement it.
 *
 * @public
 */
export type ClientEventSender = <K extends keyof ClientEventMap | (string & {})>(
  event: K,
  data: K extends keyof ClientEventMap ? ClientEventMap[K] : unknown,
) => void;

/**
 * Every event name a handler map, a dialog's `@` keys or a spec may name.
 *
 * Name it to write a list of event names down in your own code:
 *
 * ```ts
 * import type { SessionEventType } from "@alexkroman1/aai";
 *
 * const AUDITED: readonly SessionEventType[] = ["tool.called", "error.reported"];
 * ```
 *
 * @public
 */
export type SessionEventType = Extract<keyof SessionEventMap, string>;

/**
 * One **server→client** session event, envelope included: a fact the session
 * reports, in the shape it takes on the wire and in the retained stream.
 *
 * Bare, it is the whole union — what a `"*"` handler receives and what a client
 * parses. With a name (or a union of names) it is just those members.
 * Host code EMITS a {@link SessionEventBody} and the session's emitter stamps
 * the envelope — see `protocol-events.ts`.
 *
 * @public
 */
export type SessionEvent<K extends SessionEventType = SessionEventType> = SessionEventMap[K];

/**
 * A session event as its EMITTER writes it — everything but the `meta`
 * envelope, which the session stamps exactly once. Distributes over `K`, so
 * each member keeps its own `type`.
 *
 * @public
 */
export type SessionEventBody<K extends SessionEventType = SessionEventType> = {
  [T in K]: Omit<SessionEventMap[T], "meta">;
}[K];

/**
 * The events only the SESSION itself can be the source of — never a transport.
 *
 * The complement of what `aai-runtime`'s `TransportEventBody` accepts, and the
 * one place that decision is written down, so a new event is REPORTABLE by
 * default — the session publishes a report it has no `case` for — and needs
 * no edit to a list in another package. Each is here for a reason:
 * `session.configured` is the handshake, `session.reset` and
 * `session.timedOut` come from the client and the idle watchdog,
 * `custom.emitted` is `ctx.send`, `state.updated` is a `syncState` projection,
 * `usage.updated` and `guardrail.blocked` are the session's own accounting and
 * refusals, and `history.restored` is a resume.
 *
 * @public
 */
export const SESSION_SOURCED_EVENT_TYPES = [
  "session.configured",
  "session.reset",
  "session.timedOut",
  "custom.emitted",
  "state.updated",
  "usage.updated",
  "guardrail.blocked",
  "history.restored",
] as const satisfies readonly SessionEventType[];

/**
 * One of `SESSION_SOURCED_EVENT_TYPES`.
 *
 * @public
 */
export type SessionSourcedEventType = (typeof SESSION_SOURCED_EVENT_TYPES)[number];
