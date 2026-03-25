// Copyright 2025 the AAI authors. MIT license.

import { useComputed } from "@preact/signals";
import clsx from "clsx";
import type { VNode } from "preact";
import { useAutoScroll, useSession } from "../signals.ts";
import { MessageBubble } from "./message-bubble.tsx";
import { ThinkingIndicator } from "./thinking-indicator.tsx";
import { ToolCallBlock } from "./tool-call-block.tsx";
import { Transcript } from "./transcript.tsx";

/** @public */
export function MessageList({ className }: { className?: string }) {
  const { session } = useSession();
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
