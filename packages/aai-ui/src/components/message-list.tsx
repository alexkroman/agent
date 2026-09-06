// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import {
  type CSSProperties,
  type FunctionComponent,
  type MemoExoticComponent,
  memo,
  type ReactNode,
  useCallback,
} from "react";
import { useTheme } from "../context.ts";
import type { ChatMessage, ToolCallInfo } from "../types.ts";
import type { UseUserTranscriptResult } from "../use-user-transcript.ts";
import { INK_FAINT_PCT, INK_MUTED_PCT, inkTint, primaryTint } from "./_colors.ts";
import { ConversationView } from "./conversation-view.tsx";
import { Markdown } from "./markdown.tsx";
import { ToolCallBlock } from "./tool-call-block.tsx";

const DOT_STYLES: CSSProperties[] = [0, 0.16, 0.32].map((delay) => ({
  animation: "aai-bounce 1.4s infinite ease-in-out both",
  animationDelay: `${delay}s`,
}));

/** The three bouncing dots alone, with no row around them. */
function Dots(): ReactNode {
  const theme = useTheme();
  const muted = inkTint(theme.text, theme.surface, INK_MUTED_PCT);
  return DOT_STYLES.map((style, i) => (
    <div
      // biome-ignore lint/suspicious/noArrayIndexKey: static array, index as key is safe
      key={i}
      className="w-1.5 h-1.5 rounded-full"
      style={{ ...style, background: muted }}
    />
  ));
}

/** The row the thinking indicator sits in — `ConversationView` renders this exact element around `Dots`. */
const THINKING_ROW = "flex items-center gap-2 text-sm font-medium min-h-5";

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
 * The trailing thinking row is `ConversationView`'s own `role="status"`
 * element, so this is only rendered INSIDE the live transcript bubble, where
 * speech has been detected and no words have come back yet.
 *
 * @internal
 */
function ThinkingDots(): ReactNode {
  return (
    <div role="status" aria-label="Thinking" className={THINKING_ROW}>
      <Dots />
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
 * Props of {@link MessageList}.
 *
 * @public
 */
export type MessageListProps = {
  /**
   * Additional CSS class names for the outer scroll container, appended to its
   * own rather than replacing them.
   *
   * The container is an {@link AutoScroll}, so it must end up with a BOUNDED
   * height (`flex-1 min-h-0`, `h-full`, a fixed height). Unbounded, it grows
   * with the conversation and never scrolls, so nothing pins to the newest
   * message.
   */
  className?: string;
};

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
 * @param props - Container props.
 *
 * @public
 */
export const MessageList: MemoExoticComponent<FunctionComponent<MessageListProps>> = memo(
  function MessageList({ className }: MessageListProps) {
    // Every rule this list renders by — the interleave, the streaming row, the
    // `null`-vs-`""` transcript distinction, the thinking suppression — is
    // `useConversation`'s, and the ORDER of the rows, the empty-state guard and
    // the announced thinking row are `ConversationView`'s. This component is
    // the proof that both are complete: a custom chrome that reaches for them
    // gets the same conversation rather than a worse one it re-derived, and
    // this list is nothing but the stock bubbles filled into the slots.
    const theme = useTheme();

    // `useCallback` on the theme, so `ConversationView`'s per-row memo holds:
    // `MessageBubble` and `ToolCallBlock` are memo()-wrapped and their inputs
    // are referentially stable across snapshots, so appending one message
    // re-renders one row, not the whole capped list.
    const renderMessage = useCallback(
      (message: ChatMessage) => <MessageBubble message={message} theme={theme} />,
      [theme],
    );
    const renderTool = useCallback(
      (toolCall: ToolCallInfo) => <ToolCallBlock toolCall={toolCall} />,
      [],
    );
    const renderTranscript = useCallback(
      (transcript: UseUserTranscriptResult) => (
        <UserBubble theme={theme} color={inkTint(theme.text, theme.surface, INK_FAINT_PCT)}>
          {transcript.partial ? transcript.partial : <ThinkingDots />}
        </UserBubble>
      ),
      [theme],
    );

    // The streaming row is the default — `renderMessage` over a synthetic
    // assistant message the view memoizes per delta, which is exactly the
    // stable object `MessageBubble`'s memo needs.
    //
    // `AutoScroll` (inside the view) follows streamed output: its ResizeObserver
    // tracks content height, so a ToolCallBlock expanding or markdown reflowing
    // keeps the pin, and it releases when the reader scrolls up to read.
    return (
      <ConversationView
        className={className}
        style={{ background: theme.surface }}
        contentClassName="flex flex-col gap-4 p-7"
        renderMessage={renderMessage}
        renderTool={renderTool}
        renderTranscript={renderTranscript}
        thinkingClassName={THINKING_ROW}
        thinkingIndicator={<Dots />}
      />
    );
  },
);
