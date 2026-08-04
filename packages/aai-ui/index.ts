// Copyright 2025 the AAI authors. MIT license.

// Pre-connection client-config lookup (name + greeting) — internal plumbing
// used by the default client; see each symbol's own doc.
export {
  buildAgentUrl,
  type ClientConfigResponse,
  fetchClientConfig,
  loadClientConfig,
} from "./client-config.ts";
// Components
export { Button, type ButtonSize, type ButtonVariant } from "./components/button.tsx";
export { ChatView } from "./components/chat-view.tsx";
export { Controls } from "./components/controls.tsx";
export { Markdown, type MarkdownVariant } from "./components/markdown.tsx";
export { MessageList } from "./components/message-list.tsx";
export { SidebarLayout } from "./components/sidebar-layout.tsx";
export { StartScreen } from "./components/start-screen.tsx";
// The design system's console row for one tool invocation — the shared
// presentational shell behind both the deployed agent UI's tool blocks and
// the studio transcript's tool rows.
export {
  ToolCallRow,
  type ToolCallRowProps,
  type ToolCallRowVariant,
} from "./components/tool-call-row.tsx";
export type { ToolDisplayConfig } from "./components/tool-config-context.ts";
// Tool display config context — installed by `client()` from
// `ClientConfig.tools`; not something component-tier users pass themselves.
export { ToolConfigContext } from "./components/tool-config-context.ts";
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
  BaseOptions,
  ClientConfig,
  ClientHandle,
  ComponentTier,
  ConfigTier,
} from "./define-client.tsx";
// Entry
export { client } from "./define-client.tsx";
export { useAgentState, useEvent, useToolCallStart, useToolResult } from "./hooks.ts";
// Session core (for advanced use)
export { createSessionCore } from "./session-core.ts";
export type {
  AgentCustomEvent,
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
  WebSocketConstructor,
} from "./types.ts";
// Capture constraints, exported so a custom client that opens its own
// microphone gets the same signal the built-in paths do.
export { VOICE_CAPTURE_CONSTRAINTS } from "./types.ts";
