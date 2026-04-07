// Copyright 2025 the AAI authors. MIT license.

import { useComputed } from "@preact/signals";
import clsx from "clsx";
import type { VNode } from "preact";
import { useSession } from "../context.ts";
import { useAutoScroll } from "../hooks.ts";
import { MessageBubble } from "./message-bubble.tsx";
import { ThinkingIndicator } from "./thinking-indicator.tsx";
import { ToolCallBlock } from "./tool-call-block.tsx";
import { Transcript } from "./transcript.tsx";

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
        <Transcript userUtterance={session.userUtterance} />
        {showThinking.value && <ThinkingIndicator />}
        <div ref={scrollRef} />
      </div>
    </div>
  );
}
