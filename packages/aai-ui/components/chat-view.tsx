// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import { useSession, useTheme } from "../context.ts";
import type { AgentState } from "../types.ts";
import { Controls } from "./controls.tsx";
import { MessageList } from "./message-list.tsx";

// State indicator dot color map
const STATE_COLORS: Record<AgentState, string> = {
  disconnected: "rgba(255,255,255,0.422)",
  connecting: "rgba(255,255,255,0.422)",
  ready: "#7fd88f",
  listening: "#56b6c2",
  thinking: "#f5a742",
  speaking: "#e06c75",
  error: "#e06c75",
};

/**
 * The main chat interface for a voice agent session.
 * Displays a header (with optional icon, title, and state indicator), an
 * inline error banner, the {@link MessageList}, and session {@link Controls}.
 *
 * Must be rendered inside a {@link SessionProvider}.
 *
 * @example
 * ```tsx
 * <StartScreen icon="🍕" title="Pizza Palace">
 *   <ChatView />
 * </StartScreen>
 * ```
 *
 * @example Pair with a sidebar
 * ```tsx
 * <SidebarLayout sidebar={<RecipeCard />}>
 *   <ChatView className="border-l" />
 * </SidebarLayout>
 * ```
 *
 * @example Custom header icon
 * ```tsx
 * <ChatView icon={<img src="/logo.svg" />} title="My Agent" />
 * ```
 *
 * @param icon - Optional element rendered before the title in the header.
 * @param title - Optional title string for the header.
 * @param className - Additional CSS class names applied to the root element.
 *
 * @public
 */
export function ChatView({
  icon,
  title,
  className,
}: {
  icon?: ReactNode;
  title?: string;
  className?: string;
}): ReactNode {
  const session = useSession();
  const theme = useTheme();

  return (
    <div
      className={clsx("flex flex-col h-screen max-w-130 mx-auto font-aai text-sm", className)}
      style={{ background: theme.bg, color: theme.text }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 border-b shrink-0"
        style={{ borderColor: theme.border }}
      >
        {icon}
        {title ? (
          <span className="text-sm font-semibold" style={{ color: theme.primary }}>
            {title}
          </span>
        ) : (
          !icon && (
            <pre
              className="font-aai-mono text-[10px] leading-[1.1] font-bold m-0"
              style={{ color: theme.primary }}
            >
              {/* biome-ignore lint/style/useConsistentCurlyBraces: string contains escape sequence */}
              {"▄▀█ ▄▀█ █\n█▀█ █▀█ █"}
            </pre>
          )
        )}
        {/* State indicator */}
        <div className="ml-auto">
          <div
            className="inline-flex items-center justify-center gap-1.5 text-[13px] font-medium leading-[130%] capitalize"
            style={{ color: "rgba(255,255,255,0.284)" }}
            data-state={session.state}
          >
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: STATE_COLORS[session.state] }}
            />
            {session.state}
          </div>
        </div>
      </div>
      {/* Error banner */}
      {session.error && (
        <div
          className="mx-4 mt-3 px-3 py-2 rounded-aai border text-[13px] leading-[130%]"
          style={{
            borderColor: "rgba(224,108,117,0.4)",
            background: "rgba(224,108,117,0.08)",
            color: "#e06c75",
          }}
        >
          {session.error.message}
        </div>
      )}
      <MessageList />
      <Controls />
    </div>
  );
}
