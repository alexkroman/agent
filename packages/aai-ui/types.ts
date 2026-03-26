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
 * This is a UI-specific subset of the SDK's {@link @alexkroman1/aai#Message | Message} type,
 * which also includes the `"tool"` role. Renamed to `ChatMessage` to avoid
 * ambiguity when both packages are imported.
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
 * @deprecated Use {@link ChatMessage} instead. This alias will be removed in a future release.
 * @public
 */
export type Message = ChatMessage;

/**
 * Info about a tool call for display in the UI.
 *
 * @public
 */
export type ToolCallInfo = {
  toolCallId: string;
  toolName: string;
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
 * Minimal reactive container. Compatible with `@preact/signals` `Signal<T>`.
 *
 * @public
 */
export type Reactive<T> = { value: T };

/**
 * Options for creating a voice session.
 *
 * @public
 */
export type SessionOptions = {
  /** Base URL of the AAI platform server. */
  platformUrl: string;
  /**
   * Factory for creating reactive state containers.
   * Defaults to a plain mutable wrapper. Pass `signal` from
   * `@preact/signals` for automatic Preact component re-rendering.
   */
  signal?: <T>(initial: T) => Reactive<T>;
  /**
   * Function to batch multiple reactive updates.
   * Defaults to calling the function directly. Pass `batch` from
   * `@preact/signals` for optimized batched updates.
   */
  batch?: (fn: () => void) => void;
};
