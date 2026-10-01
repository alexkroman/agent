// Copyright 2026 the AAI authors. MIT license.
/**
 * Transport strategy — per-session provider wiring (S2S, pipeline, etc.) — and
 * the ONE way a transport tells the session what happened.
 *
 * ## A transport REPORTS an event; it does not name a callback per event
 *
 * This type used to carry one method per thing a transport observes — sixteen of
 * them, and its own comment said as much: "one per event the transport produces".
 * `ServerSession` then declared the same sixteen, `runtime-session-callbacks.ts`
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

import type {
  Message,
  SessionEventBody,
  SessionEventType,
  SessionSourcedEventType,
} from "@alexkroman1/aai";
import type { SessionErrorCode } from "@alexkroman1/aai/protocol";
import type { ModelMessage } from "ai";
import type { TransportCapabilities } from "./capabilities.ts";

/**
 * What a transport may report: everything in the session event vocabulary except
 * the events only the session itself can be the source of.
 *
 * DERIVED, never listed. This used to spell out the fourteen reportable names by
 * hand, so every new event was an edit here AND a new epoch of this package's
 * `session` capability — `userTurn.exceeded` and `metrics.collected` each cost
 * one — for a change this package did not make. The exclusions are declared once,
 * beside the vocabulary, as `SESSION_SOURCED_EVENT_TYPES` in `@alexkroman1/aai`
 * (with the reason each is there), so a new event is reportable by default — and
 * `handleReport` in `../session/core.ts` then fails to COMPILE until it is
 * classified: every name here has its own `case`, either acted on or listed as
 * forwarded, and the `default` is `satisfies never`.
 *
 * @public
 */
export type TransportEventType = Exclude<SessionEventType, SessionSourcedEventType>;

/**
 * One reportable event, envelope-free — the session stamps `meta` when it emits.
 * `TransportEventBody<"tool.called">` is one member.
 *
 * @public
 */
export type TransportEventBody<K extends TransportEventType = TransportEventType> =
  SessionEventBody<K>;

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
   *   see `../session/reply-done.ts`, which is entirely about the three ways it is
   *   not the end.
   * - **`agentTranscript.committed` vs `.updated` replaces a boolean.** The old
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
export type EmitErrorOptions = { fatal?: boolean };

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
export type EmitError = (
  code: SessionErrorCode,
  message: string,
  options?: EmitErrorOptions,
) => void;

/** Per-send options for {@link SendTtsText}. */
export type SendTtsOptions = {
  /**
   * Publish the cumulative TTS text as an interim `agentTranscript.updated`.
   * Defaults to `true`; the greeting and the start-failure line publish their
   * own final instead.
   */
  publishTranscript?: boolean;
  /**
   * These characters are part of the model's own reply. Defaults to `true`;
   * `false` marks dead-air filler — audible, so it moves the heard POSITION,
   * but never truncated into history (see `pipeline/heard/tracker.ts`).
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
export type SendTtsText = (text: string, options?: SendTtsOptions) => void;

/**
 * The system prompt a transport sends: the TEXT, or a thunk that answers it at
 * the moment a request is assembled.
 *
 * **Runtime-internal, and NOT the type an author writes.** `agent({
 * systemPrompt })` takes `AgentSystemPrompt` — a string or a resolver handed
 * the SESSION (`sdk/agent-instructions.ts`) — and the runtime asks that
 * resolver in `runtime-system-prompt.ts`, where the session context lives. What
 * reaches a transport is one layer down: the assembled prompt, or a nullary
 * thunk over `SessionSystemPrompt.resolve()` that re-reads it. A transport has
 * no session context to pass and needs none.
 *
 * The same shape as {@link SkipGreetingOption} below, and deliberately not a
 * second `resolveSystemPrompt?: () => string` field beside the string. Two
 * fields means every read site has to remember which one wins, and a site that
 * forgot would send the frozen string on a session that had a resolver — which
 * is silent, because the model answers fluently under the wrong instructions
 * rather than failing. One field has no precedence to forget, and the type
 * makes a bare `sessionConfig.systemPrompt` a compile error at every site that
 * has to resolve it.
 *
 * **A plain string is byte-identical to what shipped**: it resolves to itself,
 * once, at the same place the frozen value used to be read.
 *
 * @internal
 */
export type SystemPromptOption = string | (() => string);

/**
 * Resolve a {@link SystemPromptOption} at the moment a request is assembled.
 *
 * One spelling, for the reason {@link shouldSkipGreeting} is one: a read site
 * that forgot the call would hand a FUNCTION to a provider that wants a string,
 * and neither the AI SDK nor OpenAI Realtime rejects that — it stringifies, so
 * the agent's instructions become this module's source text.
 *
 * @internal
 */
export function resolveSystemPrompt(prompt: SystemPromptOption): string {
  return typeof prompt === "function" ? prompt() : prompt;
}

/**
 * Minimal config a transport may receive at construction time.
 * @internal
 */
export type TransportSessionConfig = {
  /**
   * The system prompt, or a thunk resolved per turn — see
   * {@link SystemPromptOption}. Read it through {@link resolveSystemPrompt},
   * never directly.
   */
  systemPrompt: SystemPromptOption;
  /**
   * The opening line, or a thunk read when it fires — see {@link GreetingOption}.
   * Read it through {@link resolveGreeting}, never directly.
   */
  greeting?: GreetingOption | undefined;
  history?: Message[];
};

/**
 * The two decisions every code-initiated line states — the SDK's `SayOptions`
 * minus `interrupt` (which acts on the reply before the line, not on the line).
 *
 * Every code-initiated line in pipeline mode states both — the table in
 * `pipeline/reply/lines.ts` lists each line and its values.
 *
 * @internal
 */
export type LineFlags = {
  /** On the record: history, `ctx.messages`, a committed transcript. */
  readonly record: boolean;
  /** A caller's barge-in may cut it. */
  readonly interruptible: boolean;
};

/**
 * One {@link Transport.speakLine} call's controls: `signal` takes a still-queued
 * line back, and `onStart` fires as the line takes the floor, which is what
 * tells the session a later take-back must cut a reply rather than skip one.
 * `interruptible: false` holds the caller's barge-in off while the line plays;
 * `record: false` keeps it out of history — the {@link LineFlags} every
 * code-initiated line states.
 *
 * @internal
 */
export type SpokenLine = LineFlags & {
  readonly signal: AbortSignal;
  readonly onStart: () => void;
};

/**
 * How a {@link Transport.speakLine} line ended — the SDK's `SpeechOutcome`.
 *
 * @internal
 */
export type SpokenLineOutcome = "played" | "interrupted" | "dropped";

/**
 * A session's greeting: the text, or a THUNK that knows it later.
 *
 * The thunk exists for the reason {@link SkipGreetingOption}'s does: the
 * runtime builds a transport before `session.start()`, and `sessionContext` —
 * whose `greeting` replaces the agent's for one session — answers INSIDE that
 * window. Every transport reads its greeting after `start()` (pipeline in
 * `greet()`, OpenAI Realtime in `sendGreeting`, AssemblyAI S2S in its
 * `session.update`), so a thunk resolved there sees the answer. An empty or
 * absent result means no greeting.
 *
 * @internal
 */
export type GreetingOption = string | (() => string | undefined);

/**
 * Resolve a {@link GreetingOption} at the moment the greeting is spoken or sent.
 * One spelling, for the reason {@link resolveSystemPrompt} is one: a site that
 * forgot the call would speak a function's source text.
 *
 * @internal
 */
export function resolveGreeting(greeting: GreetingOption | undefined): string | undefined {
  return typeof greeting === "function" ? greeting() : greeting;
}

/**
 * Transport abstraction — one implementation per provider strategy
 * (see `s2s-transport.ts`, `pipeline/transport.ts`).
 *
 * @internal
 */
export interface Transport {
  /**
   * What this transport can do — read this, never a verb's presence. Each
   * optional verb below is implemented iff its capability is `true`
   * (`capabilities.ts`, which also renders the guide's table).
   */
  readonly capabilities: TransportCapabilities;
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
   *
   * `modelView`, when given, is what the MODEL's own list is seeded with in
   * place of `messages` — the same conversation with each prior tool call as a
   * real `tool-call`/`tool-result` pair (`modelHistoryOf` in
   * `../session/event-history.ts`), because a lone `tool` result is an orphan the
   * provider rejects and a call rendered as TEXT is one the model imitates.
   * `messages` still seeds the tool-facing view whole.
   */
  seedHistory?(messages: readonly Message[], modelView?: readonly ModelMessage[]): void;
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
   * **The only caller so far is a durable run finishing** (`workflow/notify.ts`):
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
   * `ServerSession.announce`, which reports it rather than pretending.
   */
  injectTurn?(instruction: string): void;
  /**
   * Speak `text` VERBATIM as a reply of its own: the SDK's `speech.say`.
   *
   * Queued on the turn chain like `injectTurn`, and spoken through the
   * greeting's path (`createLineReply`): interruptible, captioned once, and
   * written to history as what was HEARD. A line asked for before TTS is open
   * waits for it, behind the greeting, as the greeting does. Resolves once the line is over, never
   * rejects: `"played"` when the playback clock ran out, `"interrupted"` when it
   * was cut after starting, `"dropped"` when it never started (taken back
   * through `line.signal` while queued, stranded by an interrupt, or the
   * transport ended).
   *
   * OPTIONAL for a sharper reason than `injectTurn`: an S2S service has no
   * verb that speaks host text as written. OpenAI Realtime's greeting is a
   * `response.create` INSTRUCTION ("Say exactly: …") the model may paraphrase,
   * which is fine for a greeting and is not what "verbatim" promises —
   * `capabilities.say` is `false` there.
   */
  speakLine?(text: string, line: SpokenLine): Promise<SpokenLineOutcome>;
  /**
   * Is a reply in flight or still playing out? What `speech.interrupt()` reads
   * to answer `false` rather than report a `reply.cancelled` for nothing.
   *
   * OPTIONAL: neither S2S transport tracks playback on the client, so the
   * session treats "unknown" as "yes" there.
   */
  isReplying?(): boolean;
  /**
   * Push-to-talk: the client OPENED a turn (`user_turn_start`). Answers `true`
   * when opening it interrupted the agent — a reply in flight or still playing
   * — so the session can do what a client `cancel` does to the reply's tools
   * and report `reply.cancelled`; `false` otherwise.
   *
   * These three verbs are OPTIONAL for the reason `injectTurn` is: neither S2S
   * service lets the host end a caller's turn, so there is nothing to call. A
   * pipeline transport implements them whatever the agent's policy and logs
   * once when an `"auto"` agent is sent one, since its transcriber already owns
   * the turn. See `pipeline/speech/manual-turn.ts`.
   */
  startUserTurn?(): boolean;
  /** Push-to-talk: close the turn and answer everything heard inside it. */
  commitUserTurn?(): void;
  /** Push-to-talk: close the turn and discard everything heard inside it. */
  clearUserTurn?(): void;
  /**
   * A TYPED user turn (the client's `user_text`): answer `text` exactly as if
   * the transcriber had committed it. The transport reports everything itself
   * — `reply.cancelled` first when a reply was in flight or still playing,
   * then the `userTranscript.committed` — because that ORDER is the stream's,
   * and a session emitting the cancel after the verb returned would record the
   * new turn before the reply it replaced ended.
   *
   * OPTIONAL for the reason `injectTurn` is: neither S2S service takes a user
   * turn as text from the host, so there is nothing to call. The session logs
   * that once and ignores the command.
   */
  sendUserText?(text: string): void;
  /**
   * Re-read the session's {@link SystemPromptOption} and push it to the
   * provider if — and only if — it has CHANGED since the last push.
   *
   * OPTIONAL, and the absence is the interesting half: a transport omits this
   * when it assembles the prompt per request anyway, which is pipeline mode.
   * There is nothing to push there, and implementing it as a no-op would invite
   * a caller to believe the call is what makes the new prompt take effect.
   *
   * OpenAI Realtime implements it because its instructions are session state on
   * the SERVICE, sent once in `session.update` at open. The changed-only rule is
   * that transport's, not this signature's: a `session.update` per turn is a
   * frame the service does not need and VAD state it may re-derive.
   *
   * **AssemblyAI S2S implements it and never will.** That service runs the tool
   * loop itself, so the host has no per-turn moment to resolve a prompt AT — see
   * "The system prompt is resolved PER TURN" in
   * `packages/aai-runtime/src/transports/CLAUDE.md`. The runtime resolves its
   * prompt ONCE for that transport, which is what shipped.
   *
   * The caller so far is nothing: this is the seam a `dialog()` phase change
   * will reach for, in the same change that installs the prompt suffix (see
   * `runtime-system-prompt.ts`).
   */
  refreshSystemPrompt?(): void;
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
export type SkipGreetingOption = boolean | (() => boolean);

/**
 * Resolve a {@link SkipGreetingOption} at the moment the greeting would fire.
 *
 * One spelling, because the alternative is `typeof x === "function" ? x() : x`
 * written at each read site — and a site that forgot the call would test a
 * FUNCTION for truthiness and suppress every greeting, which is a silent agent
 * rather than an error.
 */
export function shouldSkipGreeting(skip: SkipGreetingOption | undefined): boolean {
  return typeof skip === "function" ? skip() : skip === true;
}
