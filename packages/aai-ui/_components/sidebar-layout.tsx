// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type { ComponentChildren } from "preact";

/**
 * A two-column layout with a fixed-width sidebar and a flexible main area.
 * Commonly used to pair a custom sidebar (cart, dashboard) with `<ChatView />`.
 *
 * @example
 * ```tsx
 * <SidebarLayout sidebar={<OrderPanel />}>
 *   <ChatView />
 * </SidebarLayout>
 * ```
 *
 * @public
 */
export function SidebarLayout({
  sidebar,
  children,
  width = "20rem",
  side = "left",
  className,
}: {
  sidebar: ComponentChildren;
  children: ComponentChildren;
  width?: string | undefined;
  side?: "left" | "right" | undefined;
  className?: string;
}) {
  const sidebarEl = (
    <div
      class={clsx(
        "flex-shrink-0 flex flex-col overflow-y-auto",
        side === "left" ? "border-r border-aai-border" : "border-l border-aai-border",
      )}
      style={{ width }}
    >
      {sidebar}
    </div>
  );

  return (
    <div class={clsx("flex h-screen bg-aai-bg", className)}>
      {side === "left" && sidebarEl}
      <div class="flex-1 min-w-0">{children}</div>
      {side === "right" && sidebarEl}
    </div>
  );
}
