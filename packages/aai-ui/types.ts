// Copyright 2025 the AAI authors. MIT license.
/** Microphone buffer duration in seconds before sending to the server. */
export const MIC_BUFFER_SECONDS = 0.1;

/** Current state of the voice agent session. */
export type AgentState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

/** A chat message exchanged between user and assistant. */
export type Message = {
  /** The sender of the message. */
  role: "user" | "assistant";
  /** The text content of the message. */
  text: string;
};

/** Info about a tool call for display in the UI. */
export type ToolCallInfo = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "pending" | "done";
  result?: string | undefined;
  /** Index in the messages array where this tool call should appear. */
  afterMessageIndex: number;
};

import type { SessionErrorCode } from "@alexkroman1/aai/protocol";

export type { SessionErrorCode };

/** Error reported by the voice session. */
export type SessionError = {
  /** The category of the error. */
  readonly code: SessionErrorCode;
  /** A human-readable description of the error. */
  readonly message: string;
};

/** Options for creating a voice session. */
export type SessionOptions = {
  /** Base URL of the AAI platform server. */
  platformUrl: string;
};
