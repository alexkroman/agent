// Copyright 2025 the AAI authors. MIT license.

import { useComputed } from "@preact/signals";
import clsx from "clsx";
import type { JSX, VNode } from "preact";
import { useSession } from "../context.ts";
import { useAutoScroll } from "../hooks.ts";
import type { ChatMessage } from "../types.ts";
import { ToolCallBlock } from "./tool-call-block.tsx";

// ─── Local helpers (inlined micro-components) ───────────────────────────────

const DOT_STYLES: JSX.CSSProperties[] = [0, 0.16, 0.32].map((delay) => ({
  animation: "aai-bounce 1.4s infinite ease-in-out both",
  animationDelay: `${delay}s`,
}));

/** Animated three-dot "thinking" indicator. */
function ThinkingDots(): JSX.Element {
  return (
    <div class="flex items-center gap-2 text-aai-text-dim text-sm font-medium min-h-5">
      {DOT_STYLES.map((style, i) => (
        <div key={i} class="w-1.5 h-1.5 rounded-full bg-aai-text-dim" style={style} />
      ))}
    </div>
  );
}

/** Renders a single chat message as a styled bubble. */
function MessageBubble({ message }: { message: ChatMessage }): JSX.Element {
  const isUser = message.role === "user";
  if (isUser) {
    return (
      <div class="flex flex-col w-full items-end">
        <div class="max-w-[min(82%,64ch)] bg-aai-surface-faint border border-aai-border px-3 py-2 rounded-aai whitespace-pre-wrap wrap-break-word text-sm font-normal leading-[150%] text-aai-text">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div class="whitespace-pre-wrap wrap-break-word text-sm font-normal leading-[150%] text-aai-text">
      {message.content}
    </div>
  );
}

// ─── MessageList ────────────────────────────────────────────────────────────

/**
 * Scrollable list of all chat messages, tool-call blocks, live transcript,
 * streaming agent utterance, and a thinking indicator.
 *
 * Messages and tool calls are interleaved in the correct order. The list
 * auto-scrolls to the latest content via {@link useAutoScroll}.
 *
 * Must be rendered inside a {@link SessionProvider}.
 *
 * @example
 * ```tsx
 * <MessageList className="flex-1" />
 * ```
 *
 * @param className - Additional CSS class names applied to the scroll container.
 *
 * @public
 */
export function MessageList({ className }: { className?: string }) {
  const session = useSession();
  const scrollRef = useAutoScroll();

  const showThinking = useComputed(() => {
    if (session.state.value !== "thinking") return false;
    const last = session.toolCalls.value.at(-1);
    if (last?.status === "pending") return false;
    const lastMsg = session.messages.value.at(-1);
    return !lastMsg || lastMsg.role === "user" || Boolean(last);
  });

  const messages = session.messages.value;
  const toolCalls = session.toolCalls.value;

  // Render each message followed by its tool calls.
  const items: VNode[] = [];
  let tci = 0;
  for (const [i, msg] of messages.entries()) {
    items.push(<MessageBubble key={`msg-${i}`} message={msg} />);
    let tc = toolCalls[tci];
    while (tc && tc.afterMessageIndex <= i) {
      items.push(<ToolCallBlock key={tc.toolCallId} toolCall={tc} />);
      tci++;
      tc = toolCalls[tci];
    }
  }
  // Any remaining tool calls (still pending, no following message yet).
  let tc = toolCalls[tci];
  while (tc) {
    items.push(<ToolCallBlock key={tc.toolCallId} toolCall={tc} />);
    tci++;
    tc = toolCalls[tci];
  }

  const userUtterance = session.userUtterance.value;

  return (
    <div
      role="log"
      class={clsx("flex-1 overflow-y-auto [scrollbar-width:none] bg-aai-surface", className)}
    >
      <div class="flex flex-col gap-4.5 p-4">
        {items}
        {session.agentUtterance.value && (
          <MessageBubble message={{ role: "assistant", content: session.agentUtterance.value }} />
        )}
        {/* Inline transcript */}
        {userUtterance !== null && (
          <div class="flex flex-col items-end w-full">
            <div class="max-w-[min(82%,64ch)] whitespace-pre-wrap wrap-break-word text-sm leading-[150%] text-aai-text-muted bg-aai-surface-faint border border-aai-border px-3 py-2 rounded-aai ml-auto">
              {userUtterance || <ThinkingDots />}
            </div>
          </div>
        )}
        {showThinking.value && <ThinkingDots />}
        <div ref={scrollRef} />
      </div>
    </div>
  );
}
