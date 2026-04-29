// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { useSession, useTheme } from "../context.ts";
import type { ChatMessage } from "../types.ts";
import { ToolCallBlock } from "./tool-call-block.tsx";

const DOT_STYLES: CSSProperties[] = [0, 0.16, 0.32].map((delay) => ({
  animation: "aai-bounce 1.4s infinite ease-in-out both",
  animationDelay: `${delay}s`,
}));

function ThinkingDots(): ReactNode {
  return (
    <div
      className="flex items-center gap-2 text-sm font-medium min-h-5"
      style={{ color: "rgba(255,255,255,0.422)" }}
    >
      {DOT_STYLES.map((style, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static array, index as key is safe
          key={i}
          className="w-1.5 h-1.5 rounded-full"
          style={{ ...style, background: "rgba(255,255,255,0.422)" }}
        />
      ))}
    </div>
  );
}

function MessageBubble({
  message,
  theme,
}: {
  message: ChatMessage;
  theme: { text: string; border: string };
}): ReactNode {
  if (message.role === "user") {
    return (
      <div className="flex flex-col w-full items-end">
        <div
          className="max-w-[min(82%,64ch)] border px-3 py-2 rounded-aai whitespace-pre-wrap wrap-break-word text-sm font-normal leading-[150%]"
          style={{
            background: "rgba(255,255,255,0.031)",
            borderColor: theme.border,
            color: theme.text,
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div
      className="whitespace-pre-wrap wrap-break-word text-sm font-normal leading-[150%]"
      style={{ color: theme.text }}
    >
      {message.content}
    </div>
  );
}

function useAutoScroll() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  });
  return ref;
}

/**
 * Scrollable list of all chat messages, tool-call blocks, live transcript,
 * streaming agent utterance, and a thinking indicator.
 *
 * Messages and tool calls are interleaved in the correct order. The list
 * auto-scrolls to the latest content.
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
  const theme = useTheme();
  const scrollRef = useAutoScroll();
  const { messages, toolCalls, userTranscript, agentTranscript, state } = session;

  const items: ReactNode[] = [];
  let tci = 0;
  for (const [i, msg] of messages.entries()) {
    items.push(<MessageBubble key={`msg-${i}`} message={msg} theme={theme} />);
    let tc = toolCalls[tci];
    while (tc && tc.afterMessageIndex <= i) {
      items.push(<ToolCallBlock key={tc.callId} toolCall={tc} />);
      tci++;
      tc = toolCalls[tci];
    }
  }
  for (let tc = toolCalls[tci]; tc; tc = toolCalls[++tci]) {
    items.push(<ToolCallBlock key={tc.callId} toolCall={tc} />);
  }

  const lastToolCall = toolCalls.at(-1);
  const lastMsg = messages.at(-1);
  const showThinking =
    state === "thinking" &&
    lastToolCall?.status !== "pending" &&
    (!lastMsg || lastMsg.role === "user" || Boolean(lastToolCall));

  return (
    <div
      role="log"
      className={clsx("flex-1 overflow-y-auto [scrollbar-width:none]", className)}
      style={{ background: theme.surface }}
    >
      <div className="flex flex-col gap-4.5 p-4">
        {items}
        {agentTranscript && (
          <MessageBubble message={{ role: "assistant", content: agentTranscript }} theme={theme} />
        )}
        {userTranscript !== null && (
          <div className="flex flex-col items-end w-full">
            <div
              className="max-w-[min(82%,64ch)] whitespace-pre-wrap wrap-break-word text-sm leading-[150%] border px-3 py-2 rounded-aai ml-auto"
              style={{
                color: "rgba(255,255,255,0.284)",
                background: "rgba(255,255,255,0.031)",
                borderColor: theme.border,
              }}
            >
              {userTranscript || <ThinkingDots />}
            </div>
          </div>
        )}
        {showThinking && <ThinkingDots />}
        <div ref={scrollRef} />
      </div>
    </div>
  );
}
