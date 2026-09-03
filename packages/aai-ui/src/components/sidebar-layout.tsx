// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { useTheme } from "../context.ts";

/**
 * A two-column layout with a fixed-width sidebar and a flexible main area.
 * Commonly used to pair a custom sidebar (cart, dashboard) with `<ChatView />`.
 *
 * @example
 * ```tsx
 * import { ChatView, SidebarLayout } from "@alexkroman1/aai-ui";
 *
 * function OrderPanel() {
 *   return <div>Cart</div>;
 * }
 *
 * function App() {
 *   return (
 *     <SidebarLayout sidebar={<OrderPanel />}>
 *       <ChatView />
 *     </SidebarLayout>
 *   );
 * }
 * ```
 *
 * @param props - Layout props.
 *
 * @public
 */
export function SidebarLayout({
  sidebar,
  children,
  sidebarWidth = "18rem",
  sidebarPosition = "left",
  className,
}: {
  /** The sidebar pane — a cart, a dashboard, a run history. */
  sidebar: ReactNode;
  /** The main pane, normally a `<ChatView />`. */
  children: ReactNode;
  /**
   * Width of the sidebar as a CSS length. Defaults to `"18rem"`, and applies
   * from the `md` breakpoint up: below it the two panes stack, because a fixed
   * width that never shrinks leaves a phone-width main pane unreadable.
   */
  sidebarWidth?: string | undefined;
  /** Which side the sidebar sits on. Defaults to `"left"`. */
  sidebarPosition?: "left" | "right" | undefined;
  /** Additional CSS class names for the root element, appended to its own. */
  className?: string;
}) {
  const theme = useTheme();

  // Below `md` the two panes stack instead of sitting side by side. Side by
  // side they could not: the sidebar is a fixed width that never shrinks, so
  // at a 390px viewport it kept all 288px and left the main pane 102px —
  // about 30px of text column once ChatView's own padding and card border
  // came off, which renders a conversation one character per line. The
  // fixed width therefore only applies from `md` up, and the divider moves
  // to the horizontal edge when stacked.
  const sidebarEl = (
    <div
      className={clsx(
        "shrink-0 flex flex-col overflow-y-auto",
        "w-full max-h-[40vh] md:w-(--aai-sidebar-w) md:max-h-none",
        sidebarPosition === "left"
          ? "border-b md:border-b-0 md:border-r"
          : "border-t md:border-t-0 md:border-l order-last md:order-none",
      )}
      style={{ borderColor: theme.border }}
    >
      {sidebar}
    </div>
  );

  const vars: CSSProperties & Record<`--${string}`, string> = {
    background: theme.bg,
    "--aai-sidebar-w": sidebarWidth,
  };

  return (
    <div
      className={clsx("flex flex-col md:flex-row min-h-screen md:h-screen", className)}
      style={vars}
    >
      {sidebarPosition === "left" && sidebarEl}
      <div className="flex-1 min-w-0 min-h-0">{children}</div>
      {sidebarPosition === "right" && sidebarEl}
    </div>
  );
}
