// Copyright 2025 the AAI authors. MIT license.

import type { SessionErrorCode } from "@alexkroman1/aai/protocol";

export const MIC_BUFFER_SECONDS = 0.1;

export type AgentState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ToolCallInfo = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "done";
  result?: string | undefined;
  afterMessageIndex: number;
};

export type { SessionErrorCode } from "@alexkroman1/aai/protocol";

export type SessionError = {
  readonly code: SessionErrorCode;
  readonly message: string;
};

export type VoiceSessionOptions = {
  platformUrl: string;
  onSessionId?: ((sessionId: string) => void) | undefined;
  resumeSessionId?: string | undefined;
  WebSocket?: WebSocketConstructor | undefined;
};

export type WebSocketConstructor = {
  new (url: string | URL, protocols?: string | string[]): WebSocket;
  readonly OPEN: number;
};

export type ClientTheme = {
  bg?: string;
  primary?: string;
  text?: string;
  surface?: string;
  border?: string;
};
