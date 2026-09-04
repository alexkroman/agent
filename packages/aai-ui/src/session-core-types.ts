// Copyright 2025 the AAI authors. MIT license.

/**
 * Type declarations for the framework-agnostic voice session core.
 *
 * Split out of `session-core.ts` to keep that module focused on behaviour.
 */

import type { Epoch } from "@alexkroman1/aai/internal";
import type { VoiceIO } from "./audio.ts";
import type {
  AgentState,
  ChatMessage,
  SessionError,
  ToolCallInfo,
  WebSocketConstructor,
} from "./types.ts";

/**
 * A custom event emitted by the agent via `ctx.send(event, data)` — the
 * payload the session records in `SessionSnapshot.customEvents` (`id` is a
 * monotonic session-unique counter, `event` the name, `data` the payload).
 *
 * Deliberately NOT the DOM `CustomEvent`: it shares nothing with that
 * interface, and the old name shadowed the global in `.tsx` files.
 *
 * @public
 */
export type AgentCustomEvent = {
  readonly id: number;
  readonly event: string;
  readonly data: unknown;
};

/**
 * Immutable snapshot of the session state.
 *
 * Consumers (e.g. React hooks via `useSyncExternalStore`) read this to render.
 * A new object reference is created on every state change.
 *
 * @remarks
 * **Four fields describe liveness and they answer different questions.** They
 * are routinely collapsed into one truthy check, which is how a chrome ends up
 * showing a live indicator over a call that has ended:
 *
 * | Field | The question it answers |
 * | --- | --- |
 * | `started` | Has the caller pressed Start? `end()` puts it back to `false`; `disconnect()` does not. |
 * | `running` | Is the socket MEANT to be up? `toggle()` is what flips it. |
 * | `recording` | Is the microphone actually live right now? |
 * | `state` | What is the agent doing — see {@link AgentState}. |
 *
 * @public
 */
export type SessionSnapshot = {
  /** What the agent is doing. See {@link AgentState} for the seven members. */
  readonly state: AgentState;
  /**
   * True while the microphone is live and streaming to the server.
   *
   * This is the mic, not the session: a session can be `running` with the mic
   * still opening, and a failure to acquire it leaves this `false` with the
   * socket up.
   */
  readonly recording: boolean;
  /**
   * The WebSocket URL a program can connect to directly — the long-living
   * platform endpoint, e.g. `wss://host/my-agent/websocket`. Derived from
   * `platformUrl` at construction — available before connecting — and never
   * replaced by the brokered sandbox tunnel URL the session may actually be
   * connected to: that URL is ephemeral (it dies when the sandbox is
   * replaced), while the platform endpoint is stable and upgrades
   * programmatic clients to the current sandbox endpoint itself.
   */
  readonly apiUrl: string;
  /**
   * Monotonically increasing counter bumped whenever rendered conversation
   * content changes (`messages`, `toolCalls`, or either live transcript).
   * Cheap dependency for scroll-to-bottom effects — unlike summed lengths it
   * never collides when the capped arrays slide.
   */
  readonly contentVersion: number;
  /**
   * The conversation so far, oldest first — user and assistant turns only.
   * Tool activity is NOT in here; it is in `toolCalls`. Capped, so the oldest
   * entries slide off a long call.
   */
  readonly messages: ChatMessage[];
  /**
   * Every tool call the agent has made this session, in order, each carrying
   * its own pending/settled state. Capped like `messages`. `useToolResult` and
   * `useToolCallStart` are the narrow readers; this is the whole log.
   */
  readonly toolCalls: ToolCallInfo[];
  /**
   * Custom events the agent pushed with `ctx.send(event, data)`, in order.
   * A LOG rather than a value — `useEvent(name, cb)` is the reader that
   * delivers each one exactly once; reading this array directly means owning
   * the cursor yourself.
   */
  readonly customEvents: AgentCustomEvent[];
  /**
   * Latest state the agent projected via `syncState`, or `null` before the
   * first push. A value, not a log — a component that mounts mid-session
   * reads current state rather than replaying events it missed.
   */
  readonly agentState: unknown;
  /**
   * The caller's in-progress turn, as STT reports it.
   *
   * **`null` and `""` are different turns, and collapsing them is the mistake
   * this field invites.** `null` is silence; `""` is speech DETECTED with no
   * words back yet — where a live session sits for a few hundred milliseconds
   * at the start of every turn. Read as one falsy check, the live-transcript
   * row appears a beat late, on the first word rather than on the first sound,
   * which is the moment it exists for.
   *
   * Prefer {@link useUserTranscript}, which returns the distinction as two
   * named things (`speaking` to render on, `text` with a placeholder) rather
   * than leaving each chrome to re-derive the ternary.
   *
   * Cleared when the turn is committed to `messages`.
   */
  readonly userTranscript: string | null;
  /**
   * The agent's reply as it streams, or `null` when it is not speaking.
   * Cleared when the reply is committed to `messages`, so a chrome renders
   * this row and the finished message, never both.
   */
  readonly agentTranscript: string | null;
  /**
   * The session's current failure, or `null`. Carries a `code`
   * ({@link SessionErrorCode}), a message, and whether it was FATAL.
   *
   * A fatal error LATCHES: nothing clears it but the next completed handshake,
   * because the frame announcing a session's death is also the frame that used
   * to wipe the message explaining it. A non-fatal one is retired by later
   * activity, which is what the recovery was written for.
   */
  readonly error: SessionError | null;
  /**
   * Whether the caller has pressed Start. `false` until the first `start()`,
   * and back to `false` after `end()` — which is what makes a start-screen
   * chrome show its Start control again. `disconnect()` leaves it `true`.
   */
  readonly started: boolean;
  /**
   * Whether the session is MEANT to be connected — the pause/resume state
   * `toggle()` flips, not a report of the socket. A reconnecting session is
   * still `running`.
   */
  readonly running: boolean;
};

/**
 * A framework-agnostic voice session that manages WebSocket communication,
 * audio capture/playback, and agent state transitions.
 *
 * Uses a subscribe/getSnapshot pattern (compatible with React's
 * `useSyncExternalStore`). Implements `Disposable` for resource cleanup.
 *
 * @public
 */
export type BrowserSession = {
  /** Return the current immutable state snapshot. */
  getSnapshot(): SessionSnapshot;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(callback: () => void): () => void;
  /**
   * Open a WebSocket connection to the server and begin audio capture,
   * without touching the `started`/`running` flags — the low-level half of
   * `start()`. Most UIs call `start()` (first activation) or `toggle()`
   * (mute-style connect/disconnect) instead.
   * @param options - Optional. `signal` is an AbortSignal that, when aborted, disconnects the session.
   */
  connect(options?: { signal?: AbortSignal }): void;
  /** Cancel the current agent turn and discard in-flight TTS audio. */
  cancel(): void;
  /**
   * Clear messages, transcripts, and error state while keeping the current
   * connection (unlike `reset()`, which also reconnects).
   */
  resetState(): void;
  /**
   * Reset the session: clear state as `resetState()` does, then drop and
   * reopen the connection for a fresh conversation.
   */
  reset(): void;
  /** Close the WebSocket and release all audio resources. */
  disconnect(): void;
  /**
   * Start the session for the first time: sets `started` and `running`, then
   * connects. Use this for the initial "start conversation" action;
   * afterwards `toggle()` is the pause/resume control.
   */
  start(): void;
  /** Toggle between connected and disconnected states (after `start()`). */
  toggle(): void;
  /**
   * End the call: close the connection, clear the conversation, and return
   * to the not-started state (`started` flips back to false, so a
   * start-screen UI shows its Start control again). Unlike `reset()` —
   * which keeps the call live and only clears the conversation — the next
   * `start()` mints a brand-new session: a new session id, fresh
   * per-session tool state, greeting included.
   */
  end(): void;
  /**
   * End the current call and immediately begin a new one — `end()` then
   * `start()`, which is what "New Conversation" means for an agent that keeps
   * SESSION-SCOPED STATE.
   *
   * `reset()` is the one whose name suggests this and it is not the same
   * thing: it clears the transcript and reconnects, but the reconnect carries
   * the same `?sessionId=`, so every `sessionSlot` on the server survives —
   * the game world, the incident board, the cart. A caller who asked to start
   * over gets a blank transcript in front of the old state. This drops the
   * session id, so the next connect mints a fresh one and the greeting plays
   * again.
   *
   * Three templates had each written `session.end(); session.start();` with
   * the same paragraph explaining why `reset()` was wrong; the six on the
   * stock shell could not, because {@link Controls} called `reset()` for them.
   *
   * @example
   * ```ts
   * declare const session: import("@alexkroman1/aai-ui").Session;
   * session.restart();
   * ```
   */
  restart(): void;
  /** Alias for `disconnect` for use with `using`. */
  [Symbol.dispose](): void;
};

/**
 * Shared mutable connection state for audio initialization.
 *
 * Tracks the active WebSocket, VoiceIO instance, and a generation counter
 * that prevents stale async operations (e.g. a slow `initAudioCapture`) from
 * assigning their results to a newer connection after a reconnect.
 */
export type ConnState = {
  ws: InstanceType<WebSocketConstructor> | null;
  /**
   * The server retired this session for idleness (`idle_timeout`), so the
   * close that follows is EXPECTED and must not be retried.
   *
   * Without this the automatic reconnect would immediately re-open the
   * session the server just reclaimed — a tab left open would cycle forever
   * and the guest would never see zero sessions, which is the whole point of
   * the timeout. Reconnecting is the user's call from here (the controls
   * reconnect on demand).
   */
  retiredByServer: boolean;
  voiceIO: VoiceIO | null;
  audioSetupInFlight: boolean;
  /** Connection epoch, bumped on each connect()/retry (see `createEpoch`).
   *  Prevents a stale initAudioCapture from assigning its voiceIO to a newer
   *  connection. */
  generation: Epoch;
  /**
   * Turn epoch, bumped at every turn boundary — a committed user turn, a
   * barge-in, a reset, AND every audio-path teardown (`cleanupAudio`).
   *
   * Async playback completions (`settleWhenAudioDrained`) capture it and
   * discard themselves when it has moved. The teardown bumps are why it lives
   * here rather than as a closure local in the message handlers: a reply's
   * drain resolves whenever the AudioContext closes, so a session torn down
   * mid-speech (hang up, fatal error, reconnect) would otherwise have
   * `state: "listening"` written over its "disconnected"/"error" a moment
   * later — a dead session reporting a live mic.
   */
  turn: Epoch;
  /** Audio chunks that arrived before `voiceIO` was initialized — drained into
   *  the playback worklet once init completes. Closes the race between the
   *  server starting greeting audio (immediately on S2S connect) and the
   *  client awaiting mic permission + worklet registration. */
  preInitAudio: ArrayBuffer[];
  /** True if `audio_done` arrived before `voiceIO` was initialized. The done
   *  signal must be replayed after draining preInitAudio, or a short greeting
   *  buffered during mic-permission never finishes playing. */
  preInitDone: boolean;
};

/**
 * The two liveness fields at rest.
 *
 * `running` and `recording` ride with almost every state transition and were
 * spread as a pair of literals at seven sites across three modules — the same
 * shape `session-core-state.ts` folded `state` and `error` out of, one field
 * short. Naming it relates them: a transition that ends the call says so once,
 * and a reader looking for "what stops the mic" finds one symbol rather than a
 * grep.
 *
 * It is deliberately NOT the whole snapshot patch — a transition still supplies
 * its own `agentState.apply(...)` projection beside this.
 */
export const STOPPED = { running: false, recording: false } as const;

/**
 * A turn boundary: end the current turn and settle whatever it was playing.
 *
 * The two calls are one fact and were written out at four sites — `cancel()`
 * and `reset()` here, `reply.cancelled` and `session.reset` on the server side
 * — where the pair is load-bearing in both halves. The bump stops a stale drain
 * continuation from stamping `"listening"` over a state the session has since
 * moved to; the flush settles the interrupted turn's `done()` so it cannot
 * strand.
 *
 * Two further sites bump WITHOUT flushing (`cleanupAudio`, a committed user
 * transcript) and stay spelled out, which is the point of naming this one: a
 * bump on its own now reads as a deliberate choice rather than a forgotten
 * flush.
 */
export function bargeIn(conn: ConnState): void {
  conn.turn.bump();
  conn.voiceIO?.flush();
}
