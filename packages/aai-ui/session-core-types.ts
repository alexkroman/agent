// Copyright 2025 the AAI authors. MIT license.

/**
 * Type declarations for the framework-agnostic voice session core.
 *
 * Split out of `session-core.ts` to keep that module focused on behaviour.
 * The public types here are re-exported from `session-core.ts` for
 * backwards compatibility.
 */

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
 * A custom event emitted by the agent via `ctx.send`.
 *
 * @public
 */
export type CustomEvent = {
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
  /**
   * False when the server declared the session text-only (`tts: none()`):
   * no audio frames will arrive and replies render as text. True until the
   * server's `config` message says otherwise (voice is the default).
   */
  readonly audioOut: boolean;
  /**
   * True while the microphone is live and streaming to the server. Voice
   * sessions record for their whole lifetime; text-only sessions toggle this
   * via `startRecording()` / `stopRecording()` (the record button).
   */
  readonly recording: boolean;
  /**
   * The WebSocket URL a program can connect to directly (the same endpoint
   * this session uses), e.g. `wss://host/my-agent/websocket`. Derived from
   * `platformUrl` at construction — available before connecting.
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
  readonly customEvents: CustomEvent[];
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
   * Open a WebSocket connection to the server and begin audio capture.
   * @param options - Optional. `signal` is an AbortSignal that, when aborted, disconnects the session.
   */
  connect(options?: { signal?: AbortSignal }): void;
  /** Cancel the current agent turn and discard in-flight TTS audio. */
  cancel(): void;
  /** Clear messages, transcript, and error state without disconnecting. */
  resetState(): void;
  /** Reset the session: clear state and reconnect. */
  reset(): void;
  /** Close the WebSocket and release all audio resources. */
  disconnect(): void;
  /** Start the session for the first time (sets `started` and `running`). */
  start(): void;
  /** Toggle between connected and disconnected states. */
  toggle(): void;
  /**
   * Start streaming microphone audio (text-only sessions). Requests mic
   * access on first use. No-op in voice sessions, where the mic is always on.
   */
  startRecording(): void;
  /** Stop streaming microphone audio (text-only sessions). No-op in voice sessions. */
  stopRecording(): void;
  /**
   * Decode an audio file (any format the browser can decode), resample it to
   * the session's STT rate, and stream it to the server for transcription.
   * Resolves once the audio has been handed to the socket. Rejects when no
   * session is connected or the file cannot be decoded.
   */
  sendAudioFile(file: Blob): Promise<void>;
  /** Alias for `disconnect` for use with `using`. */
  [Symbol.dispose](): void;
};

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
  voiceIO: VoiceIO | null;
  audioSetupInFlight: boolean;
  /** Monotonically increasing counter bumped on each connect(). Prevents a stale
   *  initAudioCapture from assigning its voiceIO to a newer connection. */
  generation: number;
  /** Audio chunks that arrived before `voiceIO` was initialized — drained into
   *  the playback worklet once init completes. Closes the race between the
   *  server starting greeting audio (immediately on S2S connect) and the
   *  client awaiting mic permission + worklet registration. */
  preInitAudio: Uint8Array[];
  /** True if `audio_done` arrived before `voiceIO` was initialized. The done
   *  signal must be replayed after draining preInitAudio, or a short greeting
   *  buffered during mic-permission never finishes playing. */
  preInitDone: boolean;
  /** The server's `config` payload for the current connection — kept so
   *  text-only sessions can init the mic lazily (record button) and file
   *  uploads know the STT sample rate to resample to. */
  readyConfig: { sampleRate: number; ttsSampleRate: number } | null;
};
