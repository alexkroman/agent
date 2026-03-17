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

export {
  App,
  ChatView,
  ErrorBanner,
  MessageBubble,
  StateIndicator,
  ThinkingIndicator,
  ToolCallBlock,
  Transcript,
} from "./components.ts";
export type { MountHandle, MountOptions, MountTheme } from "./mount.tsx";

export { mount } from "./mount.tsx";
export type { MountConfig } from "./mount_context.ts";
export { useMountConfig } from "./mount_context.ts";
export type { SessionSignals } from "./signals.ts";
export {
  createSessionControls,
  SessionProvider,
  useSession,
} from "./signals.ts";
