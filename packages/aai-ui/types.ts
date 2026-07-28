// Copyright 2025 the AAI authors. MIT license.

import type { SessionErrorCode } from "@alexkroman1/aai/protocol";

/** Microphone buffer duration in seconds before sending to the server. */
export const MIC_BUFFER_SECONDS = 0.1;

/**
 * Backpressure threshold for outbound mic audio. When the WebSocket's
 * `bufferedAmount` exceeds this many bytes (~2s of 16 kHz PCM16), mic frames
 * are dropped instead of queued — for live voice, stale audio flushed into
 * STT on recovery is worse than a gap.
 */
export const MIC_SEND_MAX_BUFFERED_BYTES = 64 * 1024;

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
   */
  onSessionId?: ((sessionId: string) => void) | undefined;
  /**
   * Session ID from a previous connection. When set, the server will
   * attempt to restore persisted session state (if the agent has
   * `persistence` enabled).
   */
  resumeSessionId?: string | undefined;
  /**
   * WebSocket constructor override. Defaults to the native `WebSocket`.
   * Primarily useful for testing with a mock WebSocket.
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
  /** Background color. Default: `#101010`. */
  bg?: string;
  /** Primary accent color. Default: `#fab283`. */
  primary?: string;
  /** Main text color. */
  text?: string;
  /** Surface/card color. */
  surface?: string;
  /** Border color. */
  border?: string;
};
