// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import {
  type CSSProperties,
  memo,
  type ReactNode,
  type RefObject,
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useSessionSelector, useTheme } from "../context.ts";
import type { ChatMessage, ToolCallInfo } from "../types.ts";
import { primaryTint, TEXT_FAINT, TEXT_MUTED } from "./_colors.ts";
import { ToolCallBlock } from "./tool-call-block.tsx";

const DOT_STYLES: CSSProperties[] = [0, 0.16, 0.32].map((delay) => ({
  animation: "aai-bounce 1.4s infinite ease-in-out both",
  animationDelay: `${delay}s`,
}));

/** Animated three-dot "thinking" indicator. */
function ThinkingDots(): ReactNode {
  return (
    <div
      className="flex items-center gap-2 text-sm font-medium min-h-5"
      style={{ color: TEXT_MUTED }}
    >
      {DOT_STYLES.map((style, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static array, index as key is safe
          key={i}
          className="w-1.5 h-1.5 rounded-full"
          style={{ ...style, background: TEXT_MUTED }}
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
        style={{ color: TEXT_FAINT }}
      >
        Agent
      </span>
      <div
        className="whitespace-pre-wrap wrap-break-word text-[15px] font-normal leading-[23px]"
        style={{ color: theme.text }}
      >
        {message.content}
      </div>
    </div>
  );
});

/**
 * How close to the bottom (px) the container must be for auto-scroll to stay
 * engaged. Generous enough that an in-flight smooth scroll doesn't unpin.
 */
const NEAR_BOTTOM_PX = 96;

/**
 * Smooth-scroll to the anchor whenever the content version advances — but
 * only while the container is pinned near the bottom. A user who scrolled up
 * to read history isn't yanked back down by streaming updates; scrolling back
 * to the bottom re-engages the auto-scroll.
 *
 * The scroll runs inside `requestAnimationFrame` and is deduped per frame:
 * several snapshot updates in one frame (transcript + message + tool call)
 * trigger a single scroll after layout instead of one forced layout each.
 *
 * While a partial transcript is streaming, updates arrive faster than a
 * smooth scroll finishes — each restart leaves the animation perpetually
 * mid-flight — so `streaming` switches to an instant jump; committed-content
 * updates keep the smooth animation.
 */
function useAutoScroll(
  contentVersion: number,
  streaming: boolean,
): {
  anchorRef: RefObject<HTMLDivElement | null>;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
} {
  const anchorRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const scheduledRef = useRef(false);
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    pinnedRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX;
  }, []);
  useEffect(() => {
    if (contentVersion === 0 || scheduledRef.current || !pinnedRef.current) return;
    scheduledRef.current = true;
    requestAnimationFrame(() => {
      scheduledRef.current = false;
      if (!pinnedRef.current) return;
      anchorRef.current?.scrollIntoView({
        behavior: streamingRef.current ? "instant" : "smooth",
        block: "end",
      });
    });
  }, [contentVersion]);
  return { anchorRef, onScroll };
}

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
  const contentVersion = useSessionSelector((s) => s.contentVersion);
  const theme = useTheme();

  const showThinking = useMemo(() => {
    if (state !== "thinking") return false;
    const last = toolCalls.at(-1);
    if (last?.status === "pending") return false;
    const lastMsg = messages.at(-1);
    return !lastMsg || lastMsg.role === "user" || Boolean(last);
  }, [state, toolCalls, messages]);

  const { anchorRef, onScroll } = useAutoScroll(contentVersion, userTranscript !== null);

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

  return (
    <div
      role="log"
      className={clsx("flex-1 overflow-y-auto [scrollbar-width:none]", className)}
      style={{ background: theme.surface }}
      onScroll={onScroll}
    >
      <div className="flex flex-col gap-4 p-7">
        {items}
        {agentTranscript && (
          <MessageBubble message={{ role: "assistant", content: agentTranscript }} theme={theme} />
        )}
        {userTranscript !== null && (
          <UserBubble theme={theme} color={TEXT_FAINT}>
            {userTranscript ? userTranscript : <ThinkingDots />}
          </UserBubble>
        )}
        {showThinking && <ThinkingDots />}
        <div ref={anchorRef} />
      </div>
    </div>
  );
});
