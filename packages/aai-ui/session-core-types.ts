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
  VoiceSessionOptions,
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
 * @public
 */
export type SessionSnapshot = {
  readonly state: AgentState;
  /** True while the microphone is live and streaming to the server. */
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
  readonly messages: ChatMessage[];
  readonly toolCalls: ToolCallInfo[];
  readonly customEvents: AgentCustomEvent[];
  /**
   * Latest state the agent projected via `syncState`, or `null` before the
   * first push. A value, not a log — a component that mounts mid-session
   * reads current state rather than replaying events it missed.
   */
  readonly agentState: unknown;
  readonly userTranscript: string | null;
  readonly agentTranscript: string | null;
  readonly error: SessionError | null;
  readonly started: boolean;
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
export type SessionCore = {
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
  /** Alias for `disconnect` for use with `using`. */
  [Symbol.dispose](): void;
};

/**
 * Options accepted by `createSessionCore` — an alias of
 * {@link VoiceSessionOptions}, which documents every field. Two names, one
 * type: `client()` and `createSessionCore` share the same session options.
 *
 * @public
 */
export type SessionCoreOptions = VoiceSessionOptions;

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
