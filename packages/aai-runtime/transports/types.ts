// Copyright 2026 the AAI authors. MIT license.
/**
 * Transport strategy — per-session provider wiring (S2S, pipeline, etc.) — and
 * the ONE way a transport tells the session what happened.
 *
 * ## A transport REPORTS an event; it does not name a callback per event
 *
 * This type used to carry one method per thing a transport observes — sixteen of
 * them, and its own comment said as much: "one per event the transport produces".
 * `SessionCore` then declared the same sixteen, `runtime-session-callbacks.ts`
 * forwarded each to its twin, and four test harnesses stubbed the whole set. So a
 * seventeenth thing worth observing cost a declaration in three places and a stub
 * in four, none of which DECIDED anything: the transport already knew what
 * happened, and `sdk/protocol-events.ts` already had a name for it.
 *
 * The vocabulary is therefore the surface. {@link TransportCallbacks.report}
 * takes a {@link TransportEventBody} — the protocol's own event body narrowed to
 * the events a transport can be the source of — so a new event is one union
 * member in `protocol-events.ts` plus one `case` in the session, with nothing
 * threaded and nothing stubbed.
 *
 * ## What is NOT an event keeps its own name
 *
 * Three callbacks survive, and the rule is exactly that there is no event for
 * them:
 *
 * - {@link TransportCallbacks.onAudioChunk} — BINARY PCM, 384 kbps down. Audio
 *   frames are deliberately outside the event vocabulary (see
 *   `protocol-events.ts`, "Audio is NOT in here"), so there is nothing to report.
 * - {@link TransportCallbacks.onReplyStarted} — the wire has `reply.completed`
 *   and `reply.cancelled` and no `reply.started`. Minting one is a protocol
 *   change with a client on the other end of it, not a callback cleanup.
 */

import type { Message } from "@alexkroman1/aai";
import type { SessionErrorCode, SessionEventBody } from "@alexkroman1/aai/protocol";

/**
 * The event vocabulary narrowed to a named subset.
 *
 * The `extends` constraint is the point: a name that is not in
 * {@link SessionEventBody} is a COMPILE ERROR here, where a bare
 * `Extract<SessionEventBody, { type: "speach.started" }>` would silently resolve
 * to `never` and quietly shrink the union — the same
 * a-pattern-that-matches-nothing shape the repo's gates keep paying for.
 */
type EventsNamed<T extends SessionEventBody["type"]> = Extract<SessionEventBody, { type: T }>;

/**
 * What a transport may report: everything in the session event vocabulary except
 * the events only the session itself can be the source of.
 *
 * The five it excludes are excluded for a reason each, not by omission:
 * `session.configured` is the handshake (`SessionCore.configure`),
 * `session.reset` and `session.timed-out` come from the client and the idle
 * watchdog, `custom.emitted` is `ctx.send`, and `state.updated` is a `syncState`
 * projection. A transport reporting any of them would be describing a decision
 * it did not make.
 *
 * @public
 */
export type TransportEventBody = EventsNamed<
  | "speech.started"
  | "speech.stopped"
  | "user-transcript.updated"
  | "user-transcript.committed"
  | "agent-transcript.updated"
  | "agent-transcript.committed"
  | "tool.called"
  | "tool.completed"
  | "reply.completed"
  | "reply.cancelled"
  | "audio.completed"
  | "error.reported"
>;

/** One reportable event's `type`, for a switch or a per-type recorder. */
export type TransportEventType = TransportEventBody["type"];

/**
 * How a transport reaches the session it runs for. Constructed at
 * transport-creation time; no emitter.on-style indirection.
 *
 * @internal
 */
export type TransportCallbacks = {
  /**
   * Report one thing that happened, in the protocol's own event vocabulary.
   *
   * Two members carry a subtlety worth knowing before you report them:
   *
   * - **`reply.completed` is the PROVIDER's claim, not the turn's end.** A
   *   provider sends its `reply.done` more than once per turn, so the session
   *   decides whether this one closes the turn and may emit nothing at all —
   *   see `session-reply-done.ts`, which is entirely about the three ways it is
   *   not the end.
   * - **`agent-transcript.committed` vs `.updated` replaces a boolean.** The old
   *   `onAgentTranscript(text, interrupted)` plus a separate
   *   `onAgentTranscriptPartial(text)` encoded, in two callbacks and a flag,
   *   exactly the distinction these two event names carry — only the committed
   *   one enters history. Report the interim snapshot and an INTERRUPTED reply's
   *   final text as `.updated`; report a reply that is being recorded as
   *   `.committed`.
   */
  report(event: TransportEventBody): void;
  /** Agent audio for the client. Binary, and deliberately not an event. */
  onAudioChunk(bytes: Uint8Array): void;
  /** A reply is beginning. Not an event: the wire has no `reply.started`. */
  onReplyStarted(replyId: string): void;
};

/** Per-error options a transport may attach — the shape `onError` takes. */
export type EmitErrorOpts = { fatal?: boolean };

/**
 * A transport's own error reporter, threaded into its internals.
 *
 * **Omitting `fatal` means the session is OVER**, because `onError` defaults to
 * fatal and aai-ui answers a fatal frame by releasing the microphone and ending
 * the call. A failing TURN is not a failing session: pass `{ fatal: false }`
 * unless the caller is on a path that really terminates.
 *
 * @internal
 */
export type EmitError = (code: SessionErrorCode, message: string, opts?: EmitErrorOpts) => void;

/** Per-send options for {@link SendTtsText}. */
export type SendTtsOptions = {
  /**
   * Publish the cumulative TTS text as an interim `agent-transcript.updated`.
   * Defaults to `true`; the greeting and the start-failure line publish their
   * own final instead.
   */
  publishTranscript?: boolean;
  /**
   * These characters are part of the model's own reply. Defaults to `true`;
   * `false` marks dead-air filler — audible, so it moves the heard POSITION,
   * but never truncated into history (see `pipeline-heard.ts`).
   */
  record?: boolean;
};

/**
 * Send text to the active TTS session — the pipeline's one speaking verb.
 *
 * One type rather than one per module, because it crosses four of them (the
 * transport that implements it, the coalescer that batches it, the stream-part
 * handler that calls it, and the lifecycle/outcome modules that speak fixed
 * lines) and each had written its own signature: two options objects that named
 * different subsets, and one positional `boolean` whose meaning was only
 * legible at the definition. A parameter added to the real thing then reached
 * some call sites and not others, silently, since every field is optional.
 *
 * @internal
 */
export type SendTtsText = (text: string, opts?: SendTtsOptions) => void;

/**
 * Minimal config a transport may receive at construction time.
 * @internal
 */
export type TransportSessionConfig = {
  systemPrompt: string;
  greeting?: string;
  history?: Message[];
};

/**
 * Transport abstraction — one implementation per provider strategy
 * (see `s2s-transport.ts`, `pipeline-transport.ts`).
 *
 * @internal
 */
export interface Transport {
  /** Open any underlying connections and send initial session config. */
  start(): Promise<void>;
  /** Tear down, flush, close. Idempotent. */
  stop(): Promise<void>;
  /** Forward user audio to the provider. */
  sendUserAudio(bytes: Uint8Array): void;
  /** Forward a tool result back to the provider's reply stream. */
  sendToolResult(callId: string, result: string): void;
  /** Cancel the currently in-flight reply (barge-in / client cancel). */
  cancelReply(): void;
  /**
   * Seed prior conversation into the transport's own history on reconnect.
   * Pipeline mode owns the LLM message list, so client-resent history must
   * reach it here or a resumed agent has no memory. S2S transports keep
   * context service-side (via session.resume) and omit this.
   */
  seedHistory?(messages: readonly Message[]): void;
  /**
   * Clear the transport's conversation state (client `reset`). Pipeline mode
   * clears its message list; S2S has no client-side history to drop.
   */
  reset?(): void;
  /**
   * Take a turn NOBODY asked for: the agent speaks without a user utterance.
   *
   * The instruction becomes a synthetic user message — in the LLM's history,
   * never emitted as a user transcript — exactly as the silence nudge's prompt
   * does, so the reply that follows is an ordinary turn and is interruptible
   * like one.
   *
   * **The only caller so far is a durable run finishing** (`workflow-notify.ts`):
   * research takes minutes, the caller is on the line, and without this the
   * agent knows the answer and has no way to say so — the user has to think to
   * ask again. Anything else that learns something a caller is waiting for
   * belongs here too.
   *
   * OPTIONAL, and a transport that omits it is not a bug: S2S has no equivalent
   * verb. AssemblyAI's service dispatches replies from its own session config
   * with nothing to inject, and OpenAI Realtime's `response.create` would speak
   * without the service's conversation ever holding the instruction. A caller
   * therefore has to treat "not supported" as an answer — see
   * `SessionCore.announce`, which reports it rather than pretending.
   */
  injectTurn?(instruction: string): void;
  /**
   * The client's unplayed agent-audio backlog, in ms — the closed-loop
   * counterpart of the pipeline's open-loop playback estimate. Pipeline mode
   * feeds it to the heard cursor's clock; S2S omits it, because the service
   * owns turn-taking there and the host keeps no playback model to correct.
   */
  onPlaybackProgress?(bufferedMs: number): void;
}

/**
 * Whether to suppress a session's opening greeting: the answer, or a THUNK that
 * knows it later.
 *
 * A boolean is what a caller with the whole picture passes, and what every spec
 * here passes. The thunk exists because the runtime does NOT have the whole
 * picture when it builds a transport: `?sessionId=` suppresses the greeting on
 * the id's mere presence, and whether that resume recovered anything is only
 * known once the event log and the slot store have been read, inside the
 * `session.start()` window — after construction. Both transports already read
 * this field LAZILY (pipeline in `onAudioReady`, OpenAI Realtime in
 * `sendGreeting`), which is what makes a late answer work at all.
 *
 * See `host/session-resume-found.ts` for what the runtime's thunk reads, and why
 * a resume that found nothing has to greet.
 */
export type SkipGreeting = boolean | (() => boolean);

/**
 * Resolve a {@link SkipGreeting} at the moment the greeting would fire.
 *
 * One spelling, because the alternative is `typeof x === "function" ? x() : x`
 * written at each read site — and a site that forgot the call would test a
 * FUNCTION for truthiness and suppress every greeting, which is a silent agent
 * rather than an error.
 */
export function shouldSkipGreeting(skip: SkipGreeting | undefined): boolean {
  return typeof skip === "function" ? skip() : skip === true;
}
