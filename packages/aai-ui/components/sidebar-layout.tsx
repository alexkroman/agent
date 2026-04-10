// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import { useTheme } from "../context.ts";

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
  sidebarWidth = "18rem",
  sidebarPosition = "left",
  className,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  sidebarWidth?: string | undefined;
  sidebarPosition?: "left" | "right" | undefined;
  className?: string;
}) {
  const theme = useTheme();

  const sidebarEl = (
    <div
      className="shrink-0 flex flex-col overflow-y-auto"
      style={{
        width: sidebarWidth,
        ...(sidebarPosition === "left"
          ? { borderRight: `1px solid ${theme.border}` }
          : { borderLeft: `1px solid ${theme.border}` }),
      }}
    >
      {sidebar}
    </div>
  );

  return (
    <div className={clsx("flex h-screen", className)} style={{ background: theme.bg }}>
      {sidebarPosition === "left" && sidebarEl}
      <div className="flex-1 min-w-0">{children}</div>
      {sidebarPosition === "right" && sidebarEl}
    </div>
  );
}
