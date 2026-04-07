// Copyright 2025 the AAI authors. MIT license.
/**
 * Browser client library for AAI voice agents.
 *
 * Provides WebSocket session management, audio capture/playback,
 * and Preact UI components. For a narrower import without the Preact
 * dependency, use `@aai/ui/session`.
 *
 * @example
 * ```tsx
 * import { App, defineClient } from "@aai/ui";
 *
 * defineClient(App, { target: "#app" });
 * ```
 */

export { App } from "./components/app.tsx";
export type { ButtonSize, ButtonVariant } from "./components/button.tsx";
export { Button } from "./components/button.tsx";
export { ChatView } from "./components/chat-view.tsx";
export { Controls } from "./components/controls.tsx";
export { MessageList } from "./components/message-list.tsx";
export { SidebarLayout } from "./components/sidebar-layout.tsx";
export { StartScreen } from "./components/start-screen.tsx";
export { ToolCallBlock } from "./components/tool-call-block.tsx";
export type { ClientConfig, ClientTheme } from "./context.ts";
export { ClientConfigProvider, SessionProvider, useClientConfig, useSession } from "./context.ts";
export type { ClientHandle, ClientOptions } from "./define-client.tsx";
export { defineClient } from "./define-client.tsx";
export { useAutoScroll, useToolCallStart, useToolResult } from "./hooks.ts";
export type { VoiceSession } from "./session.ts";
export { createVoiceSession } from "./session.ts";
export type {
  AgentState,
  ChatMessage,
  SessionError,
  SessionErrorCode,
  ToolCallInfo,
  VoiceSessionOptions,
} from "./types.ts";
