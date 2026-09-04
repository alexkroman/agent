// Copyright 2026 the AAI authors. MIT license.
/**
 * `useConversation` — the exchange, already assembled, with nothing rendered.
 *
 * `<MessageList>` owns four decisions that are not obvious and are not
 * derivable from the snapshot by eye: the message/tool-call INTERLEAVE, the
 * streaming agent utterance, the live user transcript with its `null`-vs-`""`
 * protocol distinction, and the thinking indicator's suppression rule. Its only
 * prop is `className`, so the moment a client wants its own bubble markup it
 * drops all four at once — and the three hand-rolled chromes in the template
 * tree each shipped a strictly worse conversation for exactly that reason. One
 * of them runs fifteen tools and its operator sees none of them, because the
 * tool calls live in a second array nothing in that page ever reads.
 *
 * This is the headless half. `<MessageList>` is now a thin consumer of it —
 * which is the only way to know the hook is complete, since a hook that the
 * package's own list cannot be built from is a hook a custom chrome will find a
 * hole in.
 *
 * ## It subscribes NARROWLY, and that is half the value
 *
 * The three custom chromes also call whole-page `useSession()`, which re-renders
 * on *every* snapshot change — so a dispatch board re-renders at STT-partial
 * rate. `<ChatView>` deliberately avoids that with per-field
 * {@link useSessionSelector} calls, and so does this: a component that reads the
 * conversation gets the conversation's own update rate, not the session's.
 */

import { useMemo } from "react";
import { useSessionSelector } from "./context.ts";
import type { AgentState, ChatMessage, ToolCallInfo } from "./types.ts";
import { type UseUserTranscriptResult, useUserTranscript } from "./use-user-transcript.ts";

/**
 * One row of the conversation: a finalized message, or a tool invocation.
 *
 * A discriminated union rather than two arrays, because the ORDER between them
 * is the thing this hook computes — handing back two lists would hand back the
 * problem. `kind` is what a `switch` in a custom renderer narrows on.
 *
 * @public
 */
export type ConversationItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tool"; toolCall: ToolCallInfo };

/**
 * What {@link useConversation} returns.
 *
 * @public
 */
export type UseConversationResult = {
  /**
   * Messages and tool calls in one list, in the order they happened.
   *
   * Referentially stable while neither array changes, so a consumer may map it
   * inside a `useMemo` keyed on it, or hand rows to `memo()`ed components,
   * without rebuilding the list on unrelated snapshot updates.
   */
  items: readonly ConversationItem[];
  /**
   * The agent's utterance as it arrives, or `null` between turns.
   *
   * Not yet a member of `items`: it has no id and it is replaced wholesale on
   * every delta, so it is rendered as its own trailing row and disappears when
   * the finalized message takes its place.
   */
  streaming: string | null;
  /**
   * The caller's in-progress turn — {@link useUserTranscript}'s result,
   * forwarded rather than re-derived, so the `null`-vs-`""` distinction is made
   * in exactly one place.
   */
  transcript: UseUserTranscriptResult;
  /**
   * Whether to show a thinking indicator.
   *
   * The suppression rule, and it is why this is a field rather than
   * `state === "thinking"`: the agent is `thinking` for a stretch during which
   * something ELSE is already saying so. A pending tool call draws its own
   * spinner, and a trailing agent message means the reply has begun landing —
   * in both cases a second indicator underneath reads as a second thing
   * happening. So it is on only while `thinking` with no pending tool call, and
   * either no messages yet, a trailing USER message, or a settled tool call
   * after it.
   */
  thinking: boolean;
};

/**
 * Interleave messages and tool calls, ordered by insertion time.
 *
 * Each tool call belongs immediately after its anchor message
 * (`afterMessageId`); tool calls whose anchor slid out of the retained window —
 * or that were inserted before any message existed — come first, since there is
 * nothing left for them to follow.
 */
function interleave(
  messages: readonly ChatMessage[],
  toolCalls: readonly ToolCallInfo[],
): ConversationItem[] {
  const items: ConversationItem[] = [];
  let tci = 0;
  const pushToolCallsThrough = (maxAfterId: number): void => {
    let tc = toolCalls[tci];
    while (tc && tc.afterMessageId <= maxAfterId) {
      items.push({ kind: "tool", toolCall: tc });
      tci++;
      tc = toolCalls[tci];
    }
  };
  const firstMessage = messages[0];
  if (firstMessage) pushToolCallsThrough(firstMessage.id - 1);
  for (const message of messages) {
    items.push({ kind: "message", message });
    pushToolCallsThrough(message.id);
  }
  pushToolCallsThrough(Number.POSITIVE_INFINITY);
  return items;
}

/**
 * Whether the thinking indicator should show — see
 * {@link UseConversationResult.thinking} for the rule and the argument.
 */
function isThinking(
  state: AgentState,
  messages: readonly ChatMessage[],
  toolCalls: readonly ToolCallInfo[],
): boolean {
  if (state !== "thinking") return false;
  const last = toolCalls.at(-1);
  if (last?.status === "pending") return false;
  const lastMessage = messages.at(-1);
  return !lastMessage || lastMessage.role === "user" || Boolean(last);
}

/**
 * Subscribe to the conversation: the interleaved exchange, the streaming
 * utterance, the live transcript and the thinking rule — with no markup.
 *
 * Must be used inside the provider `client()` installs.
 *
 * @example A custom bubble, keeping every rule `<MessageList>` knows
 * ```tsx
 * import { useConversation } from "@alexkroman1/aai-ui";
 *
 * function Transcript() {
 *   const { items, streaming, transcript, thinking } = useConversation();
 *   return (
 *     <div>
 *       {items.map((item) =>
 *         item.kind === "message" ? (
 *           <p key={item.message.id} data-role={item.message.role}>
 *             {item.message.content}
 *           </p>
 *         ) : (
 *           <code key={item.toolCall.callId}>{item.toolCall.name}</code>
 *         ),
 *       )}
 *       {streaming !== null && <p data-role="assistant">{streaming}</p>}
 *       {transcript.speaking && <p data-role="user">{transcript.text}</p>}
 *       {thinking && <p>…</p>}
 *     </div>
 *   );
 * }
 * ```
 *
 * @returns See {@link UseConversationResult}.
 *
 * @public
 */
export function useConversation(): UseConversationResult {
  // Per-field selectors rather than one `useSession()`: the conversation
  // already re-renders on every content change, and a whole-snapshot
  // subscription would drag it through the unrelated ones too (custom events,
  // recording flips, the api URL landing).
  const state = useSessionSelector((s) => s.state);
  const messages = useSessionSelector((s) => s.messages);
  const toolCalls = useSessionSelector((s) => s.toolCalls);
  const streaming = useSessionSelector((s) => s.agentTranscript);
  const transcript = useUserTranscript();

  const items = useMemo(() => interleave(messages, toolCalls), [messages, toolCalls]);
  const thinking = useMemo(
    () => isThinking(state, messages, toolCalls),
    [state, messages, toolCalls],
  );

  // Memoized for the reason `items` is: this re-renders at STT-partial rate, so
  // a fresh bag each time makes the stability the doc promises `items` untrue of
  // the result a caller actually holds.
  return useMemo(
    () => ({ items, streaming, transcript, thinking }),
    [items, streaming, transcript, thinking],
  );
}
