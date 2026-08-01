// Copyright 2025 the AAI authors. MIT license.

// Pre-connection client-config lookup (name + greeting)
export {
  buildAgentUrl,
  type ClientConfigResponse,
  fetchClientConfig,
} from "./client-config.ts";
export { Button } from "./components/button.tsx";
export { ChatView } from "./components/chat-view.tsx";
export { Controls } from "./components/controls.tsx";
export { Markdown } from "./components/markdown.tsx";
export { MessageList } from "./components/message-list.tsx";
export { SidebarLayout } from "./components/sidebar-layout.tsx";
export { StartScreen } from "./components/start-screen.tsx";
export type { ToolDisplayConfig } from "./components/tool-config-context.ts";
// Tool config (for component-tier custom UIs)
export { ToolConfigContext } from "./components/tool-config-context.ts";
// Components
export { ApiUrlChip, SessionUrlChips, UiUrlChip } from "./components/url-chips.tsx";
export type { Session } from "./context.ts";
// Context & hooks
export {
  SessionProvider,
  ThemeProvider,
  useSession,
  useSessionSelector,
  useTheme,
} from "./context.ts";
export type {
  ClientConfig,
  ClientHandle,
} from "./define-client.tsx";
// Entry
export { client } from "./define-client.tsx";
export { useEvent, useToolCallStart, useToolResult } from "./hooks.ts";
// Session core (for advanced use)
export { createSessionCore } from "./session-core.ts";
export type {
  CustomEvent,
  SessionCore,
  SessionCoreOptions,
  SessionSnapshot,
} from "./session-core-types.ts";
// Types
export type {
  AgentState,
  ChatMessage,
  ClientTheme,
  SessionError,
  SessionErrorCode,
  ToolCallInfo,
  VoiceSessionOptions,
} from "./types.ts";
// Capture constraints, exported so a custom client that opens its own
// microphone gets the same signal the built-in paths do.
export { VOICE_CAPTURE_CONSTRAINTS } from "./types.ts";
