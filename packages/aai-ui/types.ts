// Copyright 2025 the AAI authors. MIT license.

import type { SessionErrorCode } from "@alexkroman1/aai/protocol";

/** Microphone buffer duration in seconds before sending to the server. */
export const MIC_BUFFER_SECONDS = 0.1;

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
  /** Index in the messages array where this tool call should appear. */
  afterMessageIndex: number;
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
