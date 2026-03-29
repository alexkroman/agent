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

export { App } from "./_components/app.tsx";
export type { ButtonSize, ButtonVariant } from "./_components/button.tsx";
export { Button } from "./_components/button.tsx";
export { ChatView } from "./_components/chat-view.tsx";
export { Controls } from "./_components/controls.tsx";
export { ErrorBanner } from "./_components/error-banner.tsx";
export { MessageBubble } from "./_components/message-bubble.tsx";
export { MessageList } from "./_components/message-list.tsx";
export { SidebarLayout } from "./_components/sidebar-layout.tsx";
export { StartScreen } from "./_components/start-screen.tsx";
export { StateIndicator } from "./_components/state-indicator.tsx";
export { ThinkingIndicator } from "./_components/thinking-indicator.tsx";
export { ToolCallBlock } from "./_components/tool-call-block.tsx";
export { Transcript } from "./_components/transcript.tsx";
export type { ClientConfig, ClientTheme } from "./client-context.ts";
export { useClientConfig } from "./client-context.ts";
export type { ClientHandle, ClientOptions } from "./define-client.tsx";
export { defineClient } from "./define-client.tsx";
export type { VoiceSession } from "./session.ts";
export { createVoiceSession } from "./session.ts";
export type { SessionSignals } from "./signals.ts";
export {
  createSessionControls,
  SessionProvider,
  useAutoScroll,
  useSession,
  useToolCallStart,
  useToolResult,
} from "./signals.ts";
export type {
  AgentState,
  ChatMessage,
  Reactive,
  SessionError,
  SessionErrorCode,
  ToolCallInfo,
  VoiceSessionOptions,
} from "./types.ts";
