// Copyright 2025 the AAI authors. MIT license.
/**
 * Preact UI components for AAI voice agents.
 *
 * Provides ready-made components, session context, and mount helpers.
 *
 * @example
 * ```tsx
 * import { App, mount } from "@aai/ui/components";
 *
 * mount(App, { target: "#app" });
 * ```
 *
 * @module
 */

export { App } from "./_components/app.tsx";
export { Button } from "./_components/button.tsx";
export { ChatView } from "./_components/chat_view.tsx";
export { Controls } from "./_components/controls.tsx";
export { ErrorBanner } from "./_components/error_banner.tsx";
export { MessageBubble } from "./_components/message_bubble.tsx";
export { MessageList } from "./_components/message_list.tsx";
export { SidebarLayout } from "./_components/sidebar_layout.tsx";
export { StartScreen } from "./_components/start_screen.tsx";
export { StateIndicator } from "./_components/state_indicator.tsx";
export { ThinkingIndicator } from "./_components/thinking_indicator.tsx";
export { ToolCallBlock } from "./_components/tool_call_block.tsx";
export { Transcript } from "./_components/transcript.tsx";
export type { MountHandle, MountOptions } from "./mount.tsx";
export { mount } from "./mount.tsx";
export type { MountConfig, MountTheme } from "./mount_context.ts";
export { useMountConfig } from "./mount_context.ts";
export type { SessionSignals } from "./signals.ts";
export {
  createSessionControls,
  SessionProvider,
  useAutoScroll,
  useSession,
  useToolResult,
} from "./signals.ts";
