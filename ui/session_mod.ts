// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket session management for AAI voice agents.
 *
 * Provides the low-level voice session without any Preact/UI dependencies.
 *
 * @example
 * ```ts
 * import { createVoiceSession } from "@aai/ui/session";
 *
 * const session = createVoiceSession({ platformUrl: "https://example.com" });
 * session.connect();
 * ```
 *
 * @module
 */

export type { VoiceSession } from "./session.ts";
export { createVoiceSession } from "./session.ts";
export type {
  AgentState,
  Message,
  SessionError,
  SessionErrorCode,
  SessionOptions,
  ToolCallInfo,
} from "./types.ts";
