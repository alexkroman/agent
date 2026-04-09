// Copyright 2025 the AAI authors. MIT license.

// Components
export { Button } from "./components/button.tsx";
export { ChatView } from "./components/chat-view.tsx";
export { MessageList } from "./components/message-list.tsx";
export { SidebarLayout } from "./components/sidebar-layout.tsx";
export { StartScreen } from "./components/start-screen.tsx";
export type { ToolDisplayConfig } from "./components/tool-config-context.ts";
// Tool config (for component-tier custom UIs)
export { ToolConfigContext } from "./components/tool-config-context.ts";
export type { Session } from "./context.ts";
// Context & hooks
export { SessionProvider, ThemeProvider, useSession, useTheme } from "./context.ts";
export type {
  ClientConfig,
  ClientHandle,
} from "./define-client.tsx";
// Entry
export { defineClient } from "./define-client.tsx";
export { useToolCallStart, useToolResult } from "./hooks.ts";
export type {
  SessionCore,
  SessionCoreOptions,
  SessionSnapshot,
} from "./session-core.ts";
// Session core (for advanced use)
export { createSessionCore } from "./session-core.ts";

// Types
export type {
  AgentState,
  ChatMessage,
  ClientTheme,
  SessionError,
  SessionErrorCode,
  ToolCallInfo,
  VoiceSessionOptions,
  WebSocketConstructor,
} from "./types.ts";
