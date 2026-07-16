// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef } from "react";
import { useSession, useTheme } from "../context.ts";
import type { ChatMessage, ToolCallInfo } from "../types.ts";
import { SURFACE_TINT, TEXT_FAINT, TEXT_MUTED } from "./_colors.ts";
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

/** Right-aligned user bubble — shared by finalized messages and the live transcript. */
function UserBubble({
  theme,
  color,
  children,
}: {
  theme: { border: string };
  color: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col w-full items-end">
      <div
        className="max-w-[min(82%,64ch)] border px-3 py-2 rounded-aai whitespace-pre-wrap wrap-break-word text-sm font-normal leading-[150%]"
        style={{ background: SURFACE_TINT, borderColor: theme.border, color }}
      >
        {children}
      </div>
    </div>
  );
}

type RowTheme = { text: string; border: string };

/** Renders a single chat message as a styled bubble. */
function MessageBubble({
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
    <div
      className="whitespace-pre-wrap wrap-break-word text-sm font-normal leading-[150%]"
      style={{ color: theme.text }}
    >
      {message.content}
    </div>
  );
}

/**
 * Smooth-scroll to the anchor whenever the content version advances.
 *
 * The scroll runs inside `requestAnimationFrame` and is deduped per frame:
 * several snapshot updates in one frame (transcript + message + tool call)
 * trigger a single scroll after layout instead of one forced layout each.
 */
function useAutoScroll(contentVersion: number) {
  const ref = useRef<HTMLDivElement>(null);
  const scheduledRef = useRef(false);
  useEffect(() => {
    if (contentVersion === 0 || scheduledRef.current) return;
    scheduledRef.current = true;
    requestAnimationFrame(() => {
      scheduledRef.current = false;
      ref.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });
  }, [contentVersion]);
  return ref;
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

type RowCacheEntry = { data: object; theme: RowTheme; element: ReactNode };

/**
 * Build the interleaved row elements, reusing each row's element object across
 * renders while its inputs are unchanged. Returning the identical element
 * reference lets React bail out of re-rendering that row entirely — the same
 * effect as wrapping the row components in `memo()` — so appending one message
 * re-renders one row, not the whole capped list. Rows are keyed on stable ids
 * (`ChatMessage.id`, `ToolCallInfo.callId`), which survive the sliding
 * 200-message window; message and tool-call objects are referentially stable
 * across snapshots, making the identity checks below sufficient.
 */
function useChatItems(
  messages: readonly ChatMessage[],
  toolCalls: readonly ToolCallInfo[],
  theme: RowTheme,
): ReactNode[] {
  const cacheRef = useRef<Map<string, RowCacheEntry>>(new Map());
  return useMemo(() => {
    const prev = cacheRef.current;
    const next = new Map<string, RowCacheEntry>();
    const rowFor = (key: string, data: object, make: () => ReactNode): ReactNode => {
      const hit = prev.get(key);
      const element = hit && hit.data === data && hit.theme === theme ? hit.element : make();
      next.set(key, { data, theme, element });
      return element;
    };
    const items = interleave(
      messages,
      toolCalls,
      (msg) =>
        rowFor(`m${msg.id}`, msg, () => <MessageBubble key={msg.id} message={msg} theme={theme} />),
      (tc) => rowFor(`t${tc.callId}`, tc, () => <ToolCallBlock key={tc.callId} toolCall={tc} />),
    );
    // Entries not re-added above belong to rows that slid out — dropped here.
    cacheRef.current = next;
    return items;
  }, [messages, toolCalls, theme]);
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

  const showThinking = useMemo(() => {
    if (session.state !== "thinking") return false;
    const last = session.toolCalls.at(-1);
    if (last?.status === "pending") return false;
    const lastMsg = session.messages.at(-1);
    return !lastMsg || lastMsg.role === "user" || Boolean(last);
  }, [session.state, session.toolCalls, session.messages]);

  const { messages, toolCalls, userTranscript, agentTranscript } = session;

  const scrollRef = useAutoScroll(session.contentVersion);

  const items = useChatItems(messages, toolCalls, theme);

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
          <UserBubble theme={theme} color={TEXT_FAINT}>
            {userTranscript || <ThinkingDots />}
          </UserBubble>
        )}
        {showThinking && <ThinkingDots />}
        <div ref={scrollRef} />
      </div>
    </div>
  );
}
