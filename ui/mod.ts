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

export {
  App,
  ChatView,
  createSessionControls,
  ErrorBanner,
  MessageBubble,
  type MountConfig,
  type MountHandle,
  type MountOptions,
  type MountTheme,
  mount,
  SessionProvider,
  type SessionSignals,
  StateIndicator,
  ThinkingIndicator,
  Transcript,
  useMountConfig,
  useSession,
} from "./components_mod.ts";
export {
  type AgentState,
  createVoiceSession,
  type Message,
  type SessionError,
  type SessionErrorCode,
  type SessionOptions,
  type VoiceSession,
} from "./session_mod.ts";
