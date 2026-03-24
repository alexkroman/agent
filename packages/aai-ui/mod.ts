// Copyright 2025 the AAI authors. MIT license.
/**
 * Browser client library for AAI voice agents.
 *
 * Provides WebSocket session management, audio capture/playback,
 * and Preact UI components. For narrower imports, use the sub-path exports:
 *
 * - `@aai/ui/session` — WebSocket session only (no Preact dependency)
 * - `@aai/ui/components` — Preact components, mount helpers, and signals
 *
 * @example
 * ```tsx
 * import { App, mount } from "@aai/ui";
 *
 * mount(App, { target: "#app" });
 * ```
 *
 * @module
 */

export * from "./components_mod.ts";
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
