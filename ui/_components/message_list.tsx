// Copyright 2025 the AAI authors. MIT license.

import { computed, useSignalEffect } from "@preact/signals";
import type { VNode } from "preact";
import { useRef } from "preact/hooks";
import { useSession } from "../signals.ts";
import { MessageBubble } from "./message_bubble.tsx";
import { ThinkingIndicator } from "./thinking_indicator.tsx";
import { ToolCallBlock } from "./tool_call_block.tsx";
import { Transcript } from "./transcript.tsx";

export function MessageList() {
  const { session } = useSession();
  const scrollRef = useRef<HTMLDivElement>(null);

  const showThinking = computed(() => {
    if (session.state.value !== "thinking") return false;
    const last = session.toolCalls.value.at(-1);
    if (last?.status === "pending") return false;
    const lastMsg = session.messages.value.at(-1);
    return !lastMsg || lastMsg.role === "user" || !!last;
  });

  useSignalEffect(() => {
    session.messages.value;
    session.toolCalls.value;
    session.userUtterance.value;
    session.state.value;
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
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
    <div role="log" class="flex-1 overflow-y-auto [scrollbar-width:none] bg-aai-surface">
      <div class="flex flex-col gap-4.5 p-4">
        {items}
        <Transcript userUtterance={session.userUtterance} />
        {showThinking.value && <ThinkingIndicator />}
        <div ref={scrollRef} />
      </div>
    </div>
  );
}
