// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type * as preact from "preact";
import type { ComponentChildren } from "preact";
import { useClientConfig, useSession } from "../context.ts";
import { Controls } from "./controls.tsx";
import { MessageList } from "./message-list.tsx";

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
 * <ChatView icon={<img src="/logo.svg" />} />
 * ```
 *
 * @param icon - Optional element rendered before the title in the header.
 * @param className - Additional CSS class names applied to the root element.
 *
 * @public
 */
export function ChatView({
  icon,
  className,
}: {
  icon?: ComponentChildren;
  className?: string;
}): preact.JSX.Element {
  const session = useSession();
  const { title } = useClientConfig();

  return (
    <div
      class={clsx(
        "flex flex-col h-screen max-w-130 mx-auto bg-aai-bg text-aai-text font-aai text-sm",
        className,
      )}
    >
      {/* Header */}
      <div class="flex items-center gap-3 px-4 py-3 border-b border-aai-border shrink-0">
        {icon}
        {title ? (
          <span class="text-sm font-semibold text-aai-primary">{title}</span>
        ) : (
          !icon && (
            <pre class="font-aai-mono text-[10px] leading-[1.1] font-bold text-aai-primary m-0">
              {/* biome-ignore lint/style/useConsistentCurlyBraces: string contains escape sequence */}
              {"▄▀█ ▄▀█ █\n█▀█ █▀█ █"}
            </pre>
          )
        )}
        {/* State indicator */}
        <div class="ml-auto">
          <div class="inline-flex items-center justify-center gap-1.5 text-[13px] font-medium leading-[130%] text-aai-text-muted capitalize">
            <div
              data-state={session.state.value}
              class="w-2 h-2 rounded-full data-[state=disconnected]:bg-aai-state-disconnected data-[state=connecting]:bg-aai-state-connecting data-[state=ready]:bg-aai-state-ready data-[state=listening]:bg-aai-state-listening data-[state=thinking]:bg-aai-state-thinking data-[state=speaking]:bg-aai-state-speaking data-[state=error]:bg-aai-state-error"
            />
            {session.state.value}
          </div>
        </div>
      </div>
      {/* Error banner */}
      {session.error.value && (
        <div class="mx-4 mt-3 px-3 py-2 rounded-aai border border-aai-error/40 bg-aai-error/8 text-[13px] leading-[130%] text-aai-error">
          {session.error.value.message}
        </div>
      )}
      <MessageList />
      <Controls />
    </div>
  );
}
