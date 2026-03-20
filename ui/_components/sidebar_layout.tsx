// Copyright 2025 the AAI authors. MIT license.

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
 */
export function SidebarLayout({
  sidebar,
  children,
  width = "20rem",
  side = "left",
}: {
  sidebar: ComponentChildren;
  children: ComponentChildren;
  width?: string | undefined;
  side?: "left" | "right" | undefined;
}) {
  const sidebarEl = (
    <div
      class="flex-shrink-0 flex flex-col overflow-y-auto"
      style={{
        width,
        borderRight: side === "left" ? "1px solid var(--color-aai-border)" : undefined,
        borderLeft: side === "right" ? "1px solid var(--color-aai-border)" : undefined,
      }}
    >
      {sidebar}
    </div>
  );

  return (
    <div class="flex h-screen" style={{ background: "var(--color-aai-bg)" }}>
      {side === "left" && sidebarEl}
      <div class="flex-1 min-w-0">{children}</div>
      {side === "right" && sidebarEl}
    </div>
  );
}
