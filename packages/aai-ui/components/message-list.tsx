// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import { type CSSProperties, memo, type ReactNode, useMemo } from "react";
import { useSessionSelector, useTheme } from "../context.ts";
import type { ChatMessage, ToolCallInfo } from "../types.ts";
import { INK_FAINT_PCT, INK_MUTED_PCT, inkTint, primaryTint } from "./_colors.ts";
import { AutoScroll } from "./auto-scroll.tsx";
import { Markdown } from "./markdown.tsx";
import { ToolCallBlock } from "./tool-call-block.tsx";

const DOT_STYLES: CSSProperties[] = [0, 0.16, 0.32].map((delay) => ({
  animation: "aai-bounce 1.4s infinite ease-in-out both",
  animationDelay: `${delay}s`,
}));

/**
 * Animated three-dot "thinking" indicator.
 *
 * `role="status"` with a label, for the same reason `ConsoleShell` announces
 * its error banner: three animated dots are the only signal that the agent is
 * working on a reply, and to a screen reader they are three empty `<div>`s.
 * It is also the indicator's semantic handle — a spec asserting its presence by
 * counting `.rounded-full` elements breaks when the three dots become a spinner
 * (correct behaviour, red test) and again when any sibling row gains a round
 * badge (wrong behaviour, green test).
 *
 * @internal
 */
function ThinkingDots(): ReactNode {
  const theme = useTheme();
  const muted = inkTint(theme.text, theme.surface, INK_MUTED_PCT);
  return (
    <div
      role="status"
      aria-label="Thinking"
      className="flex items-center gap-2 text-sm font-medium min-h-5"
      style={{ color: muted }}
    >
      {DOT_STYLES.map((style, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static array, index as key is safe
          key={i}
          className="w-1.5 h-1.5 rounded-full"
          style={{ ...style, background: muted }}
        />
      ))}
    </div>
  );
}

/**
 * Right-aligned user bubble — a primary-tinted card (the design system's
 * indigo-50 fill with an indigo-100 edge, derived from the theme primary so
 * custom themes stay coherent). Shared by finalized messages and the live
 * transcript.
 */
function UserBubble({
  theme,
  color,
  children,
}: {
  theme: RowTheme;
  color: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col w-full items-end">
      <div
        className="max-w-[min(78%,64ch)] border px-3.5 py-2.5 rounded-md whitespace-pre-wrap wrap-break-word text-[15px] font-normal leading-[22px]"
        style={{
          background: primaryTint(theme.primary, theme.surface, 7),
          borderColor: primaryTint(theme.primary, theme.surface, 16),
          color,
        }}
      >
        {children}
      </div>
    </div>
  );
}

type RowTheme = { text: string; border: string; primary: string; surface: string };

/**
 * Renders a single chat message: labeled agent prose, or a user bubble.
 *
 * Memoized so appending one message re-renders one row, not the whole capped
 * list: message objects and the theme are referentially stable across
 * snapshots, and rows are keyed on stable ids (`ChatMessage.id`) that survive
 * the sliding 200-message window.
 */
const MessageBubble = memo(function MessageBubble({
  message,
  theme,
}: {
  message: Pick<ChatMessage, "role" | "content">;
  theme: RowTheme;
}): ReactNode {
  if (message.role === "user") {
    return (
      <UserBubble theme={theme} color={theme.text}>
        {message.content}
      </UserBubble>
    );
  }
  return (
    <div className="flex flex-col gap-1 max-w-[82%]">
      <span
        className="text-[10px] font-medium tracking-[1.2px] uppercase leading-none"
        style={{ color: inkTint(theme.text, theme.surface, INK_FAINT_PCT) }}
      >
        Agent
      </span>
      <div
        className="wrap-break-word text-[15px] font-normal leading-[23px]"
        style={{ color: theme.text }}
      >
        <Markdown text={message.content} />
      </div>
    </div>
  );
});

/**
 * Interleave messages and tool calls into render items, ordered by insertion
 * time. Each tool call renders immediately after its anchor message
 * (`afterMessageId`); tool calls whose anchor slid out of the retained window
 * (or that were inserted before any message existed) render first.
 */
function interleave(
  messages: readonly ChatMessage[],
  toolCalls: readonly ToolCallInfo[],
  renderMessage: (msg: ChatMessage) => ReactNode,
  renderToolCall: (tc: ToolCallInfo) => ReactNode,
): ReactNode[] {
  const items: ReactNode[] = [];
  let tci = 0;
  const pushToolCallsThrough = (maxAfterId: number): void => {
    let tc = toolCalls[tci];
    while (tc && tc.afterMessageId <= maxAfterId) {
      items.push(renderToolCall(tc));
      tci++;
      tc = toolCalls[tci];
    }
  };
  const firstMessage = messages[0];
  if (firstMessage) pushToolCallsThrough(firstMessage.id - 1);
  for (const msg of messages) {
    items.push(renderMessage(msg));
    pushToolCallsThrough(msg.id);
  }
  pushToolCallsThrough(Number.POSITIVE_INFINITY);
  return items;
}

/**
 * Scrollable list of all chat messages, tool-call blocks, live transcript,
 * streaming agent utterance, and a thinking indicator.
 *
 * Messages and tool calls are interleaved in the correct order. The list
 * auto-scrolls to the latest content.
 *
 * Must be rendered inside a `SessionProvider`.
 *
 * @example
 * ```tsx
 * import { MessageList } from "@alexkroman1/aai-ui";
 *
 * function Conversation() {
 *   return <MessageList className="flex-1" />;
 * }
 * ```
 *
 * @param className - Additional CSS class names applied to the outer list container.
 *
 * @public
 */
export const MessageList = memo(function MessageList({ className }: { className?: string }) {
  // Individual selectors (cached per selector) rather than useSession(): the
  // list already re-renders on every content change, but a full-snapshot
  // subscription would also drag it through unrelated updates (custom events,
  // recording flips, ...).
  const state = useSessionSelector((s) => s.state);
  const messages = useSessionSelector((s) => s.messages);
  const toolCalls = useSessionSelector((s) => s.toolCalls);
  const userTranscript = useSessionSelector((s) => s.userTranscript);
  const agentTranscript = useSessionSelector((s) => s.agentTranscript);
  const theme = useTheme();

  const showThinking = useMemo(() => {
    if (state !== "thinking") return false;
    const last = toolCalls.at(-1);
    if (last?.status === "pending") return false;
    const lastMsg = messages.at(-1);
    return !lastMsg || lastMsg.role === "user" || Boolean(last);
  }, [state, toolCalls, messages]);

  // Stable object for the streaming bubble: an inline literal would defeat
  // MessageBubble's memo, re-rendering the streaming row on every unrelated
  // list update (state flips, STT partials, tool-call updates).
  const streamingMessage = useMemo(
    () => (agentTranscript ? { role: "assistant" as const, content: agentTranscript } : null),
    [agentTranscript],
  );

  // Memoized rows: `MessageBubble` and `ToolCallBlock` are memo()-wrapped and
  // their inputs are referentially stable across snapshots, so appending one
  // message re-renders one row, not the whole capped list.
  const items = useMemo(
    () =>
      interleave(
        messages,
        toolCalls,
        (msg) => <MessageBubble key={msg.id} message={msg} theme={theme} />,
        (tc) => <ToolCallBlock key={tc.callId} toolCall={tc} />,
      ),
    [messages, toolCalls, theme],
  );

  // `AutoScroll` follows streamed output (its ResizeObserver tracks content
  // height, so a ToolCallBlock expanding or markdown reflowing keeps the pin)
  // but releases when the user scrolls up to read, re-engaging once they
  // return to the bottom. Shared with custom-chrome clients, which is why it
  // is a component rather than the wiring inlined here.
  return (
    <AutoScroll
      className={className}
      style={{ background: theme.surface }}
      contentClassName="flex flex-col gap-4 p-7"
    >
      {items}
      {streamingMessage && <MessageBubble message={streamingMessage} theme={theme} />}
      {userTranscript !== null && (
        <UserBubble theme={theme} color={inkTint(theme.text, theme.surface, INK_FAINT_PCT)}>
          {userTranscript ? userTranscript : <ThinkingDots />}
        </UserBubble>
      )}
      {showThinking && <ThinkingDots />}
    </AutoScroll>
  );
});
