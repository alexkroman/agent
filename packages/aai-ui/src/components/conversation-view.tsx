// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import type { CSSProperties, ReactNode } from "react";
import { useMemo } from "react";
import type { ConversationLogEntry } from "../conversation-log.ts";
import type { ChatMessage, ToolCallInfo } from "../types.ts";
import { type ConversationItem, useConversation } from "../use-conversation.ts";
import type { UseUserTranscriptResult } from "../use-user-transcript.ts";
import { AutoScroll } from "./auto-scroll.tsx";
import { ToolCallRow } from "./tool-call-row.tsx";

/**
 * The id of the synthetic message the streaming row is rendered as. Real ids
 * are assigned from zero upward at append time, so a negative one cannot
 * collide with — or be mistaken for — a message in `items`.
 */
const STREAMING_MESSAGE_ID = -1;
/** The id a `spoken` log entry is rendered with — negative for the same reason. */
const SPOKEN_MESSAGE_ID = -2;

/**
 * Props of {@link ConversationView}.
 *
 * @public
 */
export type ConversationViewProps = {
  /** One finalized message, in this chrome's own markup. */
  renderMessage: (message: ChatMessage) => ReactNode;
  /**
   * One tool invocation. Absent, a compact {@link ToolCallRow} naming the tool,
   * shimmering while it is pending.
   */
  renderTool?: ((toolCall: ToolCallInfo) => ReactNode) | undefined;
  /**
   * The agent's reply as it arrives. Absent, `renderMessage` is called with a
   * synthetic assistant message carrying the text so far (its `id` is `-1`,
   * which no real message has) — every chrome so far rendered the two the same
   * way, and this keeps them from drifting.
   */
  renderStreaming?: ((text: string) => ReactNode) | undefined;
  /**
   * The caller's in-progress turn. Rendered only while `transcript.speaking`,
   * which is the `null`-vs-`""` distinction {@link useUserTranscript} makes
   * (`""` is speech detected with no words yet — render on it, and read
   * `transcript.text` for the placeholder). Absent, a muted italic line.
   */
  renderTranscript?: ((transcript: UseUserTranscriptResult) => ReactNode) | undefined;
  /**
   * Where the transcript row goes. `"inline"` (the default) is the last row
   * inside the scroll region, as `MessageList` places it; `"below"` renders it
   * after the scroll region as a sibling — the strip a two-pane board pins to
   * the bottom of its conversation column, outside the scroll.
   */
  transcriptPosition?: "inline" | "below" | undefined;
  /**
   * A persisted transcript to render IN PLACE of the live session's items —
   * `useConversationLog().entries`, whose newest session entry already is the
   * live conversation. Session entries render through `renderMessage` /
   * `renderTool`, each after `renderSessionHeader`; a `spoken` entry is
   * `renderMessage` over an assistant message (id `-2`); a `note` is
   * `renderNote`. The streaming reply, the transcript and the thinking row are
   * rendered after it as usual.
   */
  log?: readonly ConversationLogEntry[] | undefined;
  /** A log `note`. Absent, a small centred muted line. */
  renderNote?: ((entry: Extract<ConversationLogEntry, { kind: "note" }>) => ReactNode) | undefined;
  /**
   * What goes above each log `session` entry — a timestamp, a "continue"
   * button. Absent, nothing.
   */
  renderSessionHeader?:
    | ((entry: Extract<ConversationLogEntry, { kind: "session" }>) => ReactNode)
    | undefined;
  /** Rendered inside the scroll region while there is nothing to show at all. */
  empty?: ReactNode | undefined;
  /**
   * The `aria-label` of the thinking row. Default `"Thinking"`. Say who: the
   * dots are the only sign the agent is working, and to a screen reader they
   * are punctuation.
   */
  thinkingLabel?: string | undefined;
  /** What the thinking row shows. Default: three pulsing dots. */
  thinkingIndicator?: ReactNode | undefined;
  /** CSS class names for the thinking row itself (the `role="status"` element). */
  thinkingClassName?: string | undefined;
  /**
   * Classes for the {@link AutoScroll} container. It must end up with a
   * bounded height (`flex-1 min-h-0`, `h-full`) or nothing pins.
   */
  className?: string | undefined;
  /** Classes for the scroll region's content element — padding, gap, direction. */
  contentClassName?: string | undefined;
  /** Classes for the scrolling element itself. See {@link AutoScroll}. */
  scrollClassName?: string | undefined;
  /** Inline styles for the scroll container. */
  style?: CSSProperties | undefined;
};

function defaultTool(toolCall: ToolCallInfo): ReactNode {
  return (
    <ToolCallRow
      title={toolCall.name}
      pending={toolCall.status === "pending"}
      variant="compact"
      className="self-start"
    />
  );
}

function defaultNote(entry: Extract<ConversationLogEntry, { kind: "note" }>): ReactNode {
  return <p className="text-xs text-center opacity-50">{entry.text}</p>;
}

function defaultTranscript(transcript: UseUserTranscriptResult): ReactNode {
  return <p className="italic opacity-70">{transcript.text}</p>;
}

const DEFAULT_INDICATOR = (
  <span style={{ animation: "aai-pulse 1.2s ease-in-out infinite" }}>· · ·</span>
);

/**
 * The conversation's skeleton over {@link useConversation}, with every row a
 * render slot: a pinned scroll region holding the empty state, the interleaved
 * messages and tool calls, the streaming reply and the announced thinking row,
 * plus the live transcript — inside the scroll or pinned beneath it.
 *
 * `useConversation()` already made the DATA one thing: the interleave, the
 * streaming utterance, the `null`-vs-`""` transcript distinction and the
 * thinking-suppression rule. What three custom chromes then each wrote around
 * it was the same fifty lines of STRUCTURE: an `AutoScroll` with a bounded
 * height, an empty-state guard on `items.length === 0 && streaming === null`,
 * the map with its keys, the streaming row, the thinking row with its
 * `role="status"` and `aria-label` (and the same comment about screen readers
 * hearing punctuation), the transcript guarded on `speaking`. The bubbles are
 * the part each template exists to show, so those are slots; the order and the
 * accessibility contract are this component's.
 *
 * {@link MessageList} is this with the stock bubbles filled in.
 *
 * Must be rendered inside the providers `mountClient()` installs.
 *
 * @example A board's radio log: its own bubbles, the stock tool row, the transcript pinned below
 * ```tsx
 * import { ConversationView } from "@alexkroman1/aai-ui";
 *
 * function RadioLog() {
 *   return (
 *     <ConversationView
 *       contentClassName="p-4 flex flex-col gap-2"
 *       empty={<p className="text-center opacity-60">Standing by.</p>}
 *       renderMessage={({ role, content }) => (
 *         <div className={role === "assistant" ? "self-start" : "self-end"}>{content}</div>
 *       )}
 *       renderTranscript={({ text }) => <div className="px-4 py-2 italic">{text}</div>}
 *       transcriptPosition="below"
 *       thinkingLabel="Dispatch is thinking"
 *     />
 *   );
 * }
 * ```
 *
 * @param props - See {@link ConversationViewProps}.
 *
 * @public
 */
export function ConversationView({
  renderMessage,
  renderTool = defaultTool,
  renderStreaming,
  renderTranscript = defaultTranscript,
  transcriptPosition = "inline",
  log,
  renderNote = defaultNote,
  renderSessionHeader,
  empty,
  thinkingLabel = "Thinking",
  thinkingIndicator = DEFAULT_INDICATOR,
  thinkingClassName,
  className,
  contentClassName,
  scrollClassName,
  style,
}: ConversationViewProps): ReactNode {
  const { items, streaming, transcript, thinking } = useConversation();

  // Memoized on the renderers as well as the items: a caller that hoists or
  // `useCallback`s its renderers (as `MessageList` does) then pays for one row
  // per appended message, and one that writes them inline pays what it wrote.
  // In log mode the live items are unused, so they are not a dependency there.
  const liveItems = log ? undefined : items;
  const rows = useMemo(() => {
    const renderItem = (item: ConversationItem, key: string): ReactNode =>
      item.kind === "message"
        ? renderKeyed(`${key}m${item.message.id}`, renderMessage(item.message))
        : renderKeyed(`${key}t${item.toolCall.callId}`, renderTool(item.toolCall));
    // Prefixed, so a numeric message id and a tool call whose id happens to be
    // the same digits cannot share a key.
    if (!log) return (liveItems ?? []).map((item) => renderItem(item, ""));
    return logRows(log, renderItem, renderMessage, renderNote, renderSessionHeader);
  }, [liveItems, log, renderMessage, renderTool, renderNote, renderSessionHeader]);

  // A stable object per streaming text, so a memoized bubble handed the default
  // streaming message re-renders on a new delta and not on every list update.
  const streamingMessage = useMemo<ChatMessage | null>(
    () =>
      streaming === null
        ? null
        : { id: STREAMING_MESSAGE_ID, role: "assistant", content: streaming },
    [streaming],
  );

  const transcriptRow = transcript.speaking ? renderTranscript(transcript) : null;

  return (
    <>
      <AutoScroll
        className={className}
        contentClassName={contentClassName}
        scrollClassName={scrollClassName}
        style={style}
      >
        {(log ?? items).length === 0 && streaming === null && empty}
        {rows}
        {streamingMessage !== null &&
          (renderStreaming
            ? renderStreaming(streamingMessage.content)
            : renderMessage(streamingMessage))}
        {transcriptPosition === "inline" && transcriptRow}
        {/* Announced: the indicator is the only sign the agent is working, and
            to a screen reader it is punctuation. Same contract as the stock
            `MessageList`, and the reason this row is not a slot. */}
        {thinking && (
          <div role="status" aria-label={thinkingLabel} className={thinkingClassName}>
            {thinkingIndicator}
          </div>
        )}
      </AutoScroll>
      {transcriptPosition === "below" && transcriptRow}
    </>
  );
}

/**
 * A log's rows. Keys are the entry's own identity (kind, time, session and run)
 * plus a repeat count, not its index: the log is trimmed from the FRONT, and an
 * index key would remount every row on each trim. Items within a session entry
 * are keyed by position — a chain is append-only.
 */
function logRows(
  log: readonly ConversationLogEntry[],
  renderItem: (item: ConversationItem, key: string) => ReactNode,
  renderMessage: (message: ChatMessage) => ReactNode,
  renderNote: (entry: Extract<ConversationLogEntry, { kind: "note" }>) => ReactNode,
  renderSessionHeader:
    | ((entry: Extract<ConversationLogEntry, { kind: "session" }>) => ReactNode)
    | undefined,
): ReactNode[] {
  const seen = new Map<string, number>();
  return log.flatMap((entry) => {
    const id =
      entry.kind === "session"
        ? `s${entry.at}:${entry.sessionId}:${entry.run}`
        : `${entry.kind}${entry.at}`;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    const key = `${id}#${n}`;
    if (entry.kind === "note") return [renderKeyed(key, renderNote(entry))];
    if (entry.kind === "spoken") {
      const said: ChatMessage = { id: SPOKEN_MESSAGE_ID, role: "assistant", content: entry.text };
      return [renderKeyed(key, renderMessage(said))];
    }
    return [
      renderKeyed(`${key}h`, renderSessionHeader?.(entry) ?? null),
      ...entry.items.map((item, i) => renderItem(item, `${key}/${i}`)),
    ];
  });
}

/** Give a slot's output a key without asking the renderer to remember one. */
function renderKeyed(key: string, node: ReactNode): ReactNode {
  return <RowSlot key={key}>{node}</RowSlot>;
}

/**
 * A keyed wrapper that renders nothing of its own — a `Fragment` with a key
 * would do, but spelling it as a component keeps `renderKeyed` a plain call.
 */
function RowSlot({ children }: { children: ReactNode }): ReactNode {
  return children;
}
