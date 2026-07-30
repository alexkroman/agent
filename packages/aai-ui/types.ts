// Copyright 2025 the AAI authors. MIT license.

import type { SessionErrorCode } from "@alexkroman1/aai/protocol";

// Client audio/backpressure budgets live in the SDK's constants module,
// next to the host-side halves of the same wire paths (e.g.
// FILE_UPLOAD_CHUNK_BYTES, MAX_CLIENT_WS_BUFFERED_BYTES).
export {
  FILE_SEND_BACKOFF_MS,
  MIC_BUFFER_SECONDS,
  MIC_SEND_MAX_BUFFERED_BYTES,
  MIC_SILENCE_PROBE_MS,
  PLAYBACK_CONCEAL_FADE_MS,
  PLAYBACK_CONCEAL_FLOOR,
  PLAYBACK_JITTER_MS,
  PLAYBACK_REFILL_MS,
} from "@alexkroman1/aai";

/**
 * Current state of the voice agent session.
 *
 * @public
 */
export type AgentState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

/**
 * A chat message exchanged between user and assistant.
 *
 * @public
 */
export type ChatMessage = {
  /**
   * Monotonically increasing, session-unique message id assigned at append
   * time. Stable across snapshot updates and window slides — use it as a
   * render key.
   */
  id: number;
  /** The sender of the message. */
  role: "user" | "assistant";
  /** The text content of the message. */
  content: string;
};

/**
 * Info about a tool call for display in the UI.
 *
 * @public
 */
export type ToolCallInfo = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "done";
  result?: string | undefined;
  /**
   * Monotonically increasing, session-unique insertion sequence number.
   * Tool calls in a snapshot are always sorted ascending by `seq`.
   */
  seq: number;
  /**
   * `id` of the last {@link ChatMessage} present when this tool call was
   * inserted (`-1` when there were none). The tool call renders immediately
   * after that message; if the anchor message has slid out of the retained
   * window, the tool call renders before all messages.
   */
  afterMessageId: number;
};

export type { SessionErrorCode } from "@alexkroman1/aai/protocol";

/**
 * Error reported by the voice session.
 *
 * @public
 */
export type SessionError = {
  /** The category of the error. */
  readonly code: SessionErrorCode;
  /** A human-readable description of the error. */
  readonly message: string;
};

/**
 * Options for creating a voice session.
 *
 * @public
 */
export type VoiceSessionOptions = {
  /** Base URL of the AAI platform server. */
  platformUrl: string;
  /**
   * Called when the server sends a session ID in the config message.
   * Use this to store the ID (e.g. in localStorage) for reconnection
   * via `resumeSessionId`.
   *
   * Treat session IDs as sensitive: whoever holds one can resume the
   * session and read its replayed history. They travel as a WebSocket
   * query parameter (browsers cannot set WS headers), so they may appear
   * in proxy and server access logs — don't put them in shared URLs.
   */
  onSessionId?: ((sessionId: string) => void) | undefined;
  /**
   * Session ID from a previous connection. When set, the server will
   * attempt to restore persisted session state (if the agent has
   * `persistence` enabled). Sensitive — see {@link onSessionId}.
   */
  resumeSessionId?: string | undefined;
  /**
   * WebSocket constructor override. Primarily useful for testing with a mock
   * WebSocket. When omitted, the session uses a reconnecting WebSocket
   * (partysocket) that retries with exponential backoff after an unexpected
   * close and resumes the session; an injected constructor is used as-is and
   * never reconnects on its own.
   */
  WebSocket?: WebSocketConstructor | undefined;
};

/**
 * Minimal WebSocket constructor type accepted by {@link VoiceSessionOptions}.
 *
 * @public
 */
export type WebSocketConstructor = {
  new (url: string | URL, protocols?: string | string[]): WebSocket;
  readonly OPEN: number;
};

/**
 * Theme color overrides for the AAI UI components.
 *
 * @public
 */
export type ClientTheme = {
  /** Background color, also painted on `html`/`body`. Default: `#FBF8F2`. */
  bg?: string;
  /** Primary accent color. Default: `#3F2BC1`. */
  primary?: string;
  /** Main text color. */
  text?: string;
  /** Surface/card color. */
  surface?: string;
  /** Border color. */
  border?: string;
};
