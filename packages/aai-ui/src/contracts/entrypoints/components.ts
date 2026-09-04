// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `components`.
 *
 * The design system a custom chrome is assembled from — the chat surface, the
 * controls, the tool-call row, and the scroll pinning under them.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  AutoScroll,
  BulletList,
  type BulletListProps,
  Button,
  type ButtonSize,
  type ButtonVariant,
  ChatView,
  ConsoleShell,
  type ConsoleShellProps,
  Controls,
  type ControlsProps,
  Facts,
  type FactsProps,
  Markdown,
  type MarkdownProps,
  type MarkdownVariant,
  MessageList,
  type MessageListProps,
  SessionErrorBanner,
  type SessionErrorBannerProps,
  SidebarLayout,
  StartScreen,
  ToolCallRow,
  type ToolCallRowProps,
  type ToolCallRowVariant,
} from "../../index.ts";
