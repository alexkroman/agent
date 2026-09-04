// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `components`.
 *
 * The design system a custom chrome is assembled from — the chat surface, the
 * controls, the tool-call row, and the BEHAVIOUR primitives under them: the
 * scroll pinning, and the transient flash a copy button or a save note needs.
 * Those two are hooks rather than elements and belong here rather than under
 * `hooks`, which promises what a client reads off the AGENT; these read
 * nothing and render nothing, they hold a rule a chrome would otherwise
 * re-derive.
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
  type UseCopyResult,
  type UseFlashResult,
  useCopy,
  useFlash,
} from "../../index.ts";
