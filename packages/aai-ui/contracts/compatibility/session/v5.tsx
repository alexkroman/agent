// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:session` epoch 5.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * **Epoch 5 ADDS `useConversation`, `UseConversationResult` and
 * `ConversationItem`.** Nothing was removed, so epochs 2, 3 and 4 are RETAINED
 * and all three compile unchanged beside this file.
 *
 * `<MessageList>` used to own four decisions and expose one prop, so a client
 * that wanted its own bubble markup dropped all four at once: the
 * message/tool-call INTERLEAVE (a tool call renders after its `afterMessageId`
 * anchor; an orphan whose anchor slid out of the 200-message window leads), the
 * streaming agent bubble, the live transcript row with its `null`-vs-`""`
 * protocol distinction, and the thinking indicator's suppression rule. Three
 * template chromes did exactly that and shipped a worse conversation each — one
 * of them runs fifteen tools and rendered none of them, because tool calls live
 * in a second array nothing in that page read.
 *
 * So the conversation is headless now and `<MessageList>` is a thin consumer of
 * it. **That is the acceptance test rather than a tidiness argument**: a hook the
 * package's own list cannot be rebuilt from is a hook a custom chrome will find
 * a hole in.
 *
 * The second half of its value is what it does NOT do. It subscribes with
 * per-field selectors rather than `useSession()`, which re-renders on every
 * snapshot change — the three hand-rolled chromes all took the whole snapshot,
 * so a dispatch board re-rendered at STT-partial rate.
 */

import {
  type AgentState,
  type ChatMessage,
  type ConversationItem,
  type Session,
  type UseConversationResult,
  useConversation,
  useSession,
} from "../../../index.ts";

/** Unchanged from epoch 4: the dot's colour per state, as an EXHAUSTIVE map. */
const STATE_COLORS = {
  disconnected: "#6b7280",
  connecting: "#6b7280",
  ready: "#22c55e",
  listening: "#22c55e",
  thinking: "#eab308",
  speaking: "#3b82f6",
  error: "#6b7280",
} satisfies Record<AgentState, string>;

/** Unchanged from epoch 4: one `useSession()` call is snapshot AND controls. */
export function CallBar() {
  const session: Session = useSession();
  const state: AgentState = session.state;

  if (!session.started) {
    return (
      <button type="button" onClick={session.start}>
        Start
      </button>
    );
  }

  return (
    <div>
      <span style={{ background: STATE_COLORS[state] }} />
      <button type="button" onClick={session.toggle}>
        {session.running ? "Pause" : "Resume"}
      </button>
      <button type="button" onClick={session.end}>
        Hang up
      </button>
    </div>
  );
}

/** Unchanged from epoch 4: the snapshot half on its own. */
export function Transcript() {
  const { messages, state } = useSession();
  const history: readonly ChatMessage[] = messages;
  return (
    <ol aria-busy={state === "thinking"}>
      {history.map((message) => (
        <li key={message.id} data-role={message.role}>
          {message.content}
        </li>
      ))}
    </ol>
  );
}

/**
 * New at epoch 5: a chrome's own bubbles over the package's own interleave.
 *
 * `items` is a DISCRIMINATED union, which is what makes the tool calls
 * unmissable — a page that renders only `kind === "message"` has visibly decided
 * to, where a page reading a `messages` array has silently not noticed the
 * second one.
 */
export function Board() {
  const { items, streaming, transcript, thinking }: UseConversationResult = useConversation();

  return (
    <ol>
      {items.map((item: ConversationItem) =>
        item.kind === "message" ? (
          <li key={item.message.id} data-role={item.message.role}>
            {item.message.content}
          </li>
        ) : (
          <li key={item.toolCall.callId} data-tool={item.toolCall.name}>
            {item.toolCall.name}
          </li>
        ),
      )}
      {streaming !== null && <li data-streaming>{streaming}</li>}
      {transcript.text !== null && <li data-live>{transcript.text}</li>}
      {thinking && <li aria-busy>…</li>}
    </ol>
  );
}

/** The whole result is nameable, so a chrome may compute it one level up. */
export function itemCount(conversation: UseConversationResult): number {
  return conversation.items.length;
}
