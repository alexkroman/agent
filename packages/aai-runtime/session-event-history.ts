// Copyright 2026 the AAI authors. MIT license.
/**
 * The conversation, read back out of the session's own event stream.
 *
 * This is what replaced the client telling the server what it remembered. A
 * reconnecting browser used to push its `messages` array back in a `history`
 * frame, which made the CLIENT the authority on the agent's memory — it could
 * omit turns, truncate them, reorder them or invent them, and a client with
 * nothing to send (a second tab, a phone call resuming onto a replacement
 * sandbox, an operator reattaching) restored nothing at all.
 *
 * ## Two events, and only two
 *
 * `user-transcript.committed` and `agent-transcript.committed` are exactly the
 * events the session emits at the moments it appends to history, which is what
 * makes this a READ of the record rather than a second derivation of it. In
 * particular it must not read `agent-transcript.updated`: those are interim
 * snapshots, they legitimately shrink and differ mid-string (the dead-air filler
 * the caller hears is in them and not in the reply), and an INTERRUPTED reply's
 * last snapshot is not a record of anything — see "History records what was
 * HEARD" in the SDK guide.
 *
 * The consequence to know: an interrupted reply contributes NO assistant turn
 * here, where the live session's own truncation rule contributes the words the
 * caller is estimated to have heard, marked `[interrupted]`. So a resumed
 * conversation is slightly shorter than one that never dropped. That is the
 * cheap direction of the same trade the live rule makes — under-keeping costs a
 * little redundancy, over-keeping tells the model it delivered information the
 * caller never got.
 *
 * ## The rule has ONE home now, and it used to have three
 *
 * {@link historyMessageOf} is it: the two functions below and
 * `session-core.ts`'s live event dispatch all went through their own copy of
 * "append on a committed transcript, in this role", which is how the two rules
 * governing a RECOVERY phrase came to compose into the outcome both forbid.
 * `pipeline-turn-outcome.ts`'s table says `errorPhrase` and
 * `startFailurePhrase` reach `history / ctx.messages: never`, and its transcript
 * row says FINAL — so the phrase was committed for the caption's sake, kept out
 * of the live pipeline history by the transport, and then appended anyway by
 * the two copies of this rule the transport does not own: into `ctx.messages`
 * by the live dispatch, on the same call, and back into the model's context by
 * `seedHistory` on the first reconnect, compounding with every one after it.
 * The phrase now says what it is (`recovery`, see
 * `AgentTranscriptRecovery` in `sdk/protocol-events.ts`) and one reader decides.
 */

import type { Message } from "@alexkroman1/aai";
import { DEFAULT_MAX_HISTORY } from "@alexkroman1/aai/internal";
import type { RestoredToolCall, SessionEvent, SessionEventBody } from "@alexkroman1/aai/protocol";

/**
 * The conversation message one event contributes, or `undefined` for an event
 * that contributes none.
 *
 * The ONE statement of "what is a turn" — read by both readers below and by the
 * live dispatch in `session-core.ts`, which is what makes the three agree by
 * construction rather than by three authors remembering. See the module doc.
 *
 * Two events append, and a third looks exactly like one of them and does not: a
 * committed agent transcript carrying `recovery` is a phrase the TRANSPORT
 * spoke because the model could not, and it is deliberately audible, captioned,
 * and absent from the record. An event with no `recovery` — including every
 * event written before the field existed — is an ordinary reply.
 *
 * @internal
 */
export function historyMessageOf(event: SessionEventBody): Message | undefined {
  if (event.type === "user-transcript.committed") return { role: "user", content: event.text };
  if (event.type !== "agent-transcript.committed") return undefined;
  if (event.recovery !== undefined) return undefined;
  return { role: "assistant", content: event.text };
}

/**
 * The conversation these events record, oldest first and capped like the live
 * session's own window.
 *
 * @internal
 */
export function messagesFromEvents(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];
  for (const event of events) {
    if (event.type === "session.reset") {
      // A reset DISCARDED the conversation, so everything before it is not this
      // conversation. Replaying across one would restore turns the caller
      // explicitly cleared — and the agent would answer as though they had not.
      messages.length = 0;
      continue;
    }
    const message = historyMessageOf(event);
    if (message) messages.push(message);
  }
  // Trimmed at the FRONT, matching the live window (`DEFAULT_MAX_HISTORY`): a
  // resumed session must not come back holding more context than it could have
  // accumulated without dropping.
  if (messages.length > DEFAULT_MAX_HISTORY) {
    messages.splice(0, messages.length - DEFAULT_MAX_HISTORY);
  }
  return messages;
}

/**
 * The conversation AND the tool calls interleaved through it — one walk, so the
 * anchors cannot disagree with the messages they point at.
 *
 * The messages are what the model gets back (`messagesFromEvents` above, kept
 * because the LLM's history is transcripts only). The tool calls are for the
 * CLIENT: `ToolCallInfo` blocks render inside the transcript, anchored to the
 * message they followed, and without them a resumed conversation comes back as
 * plain dialogue with every "looked up your order" row missing — which reads as
 * the agent having done less than it did.
 *
 * **The anchor is an INDEX into `messages`, never an id.** The client mints
 * `ChatMessage.id` itself as a render key, so an id chosen here would be a second
 * numbering scheme over one list. `-1` means "before any message", which is the
 * same sentinel the live path uses.
 *
 * A call with no `tool.completed` stays PENDING, deliberately: it may genuinely
 * have been in flight when the process died, and reporting it as done would
 * invent a result.
 *
 * @internal
 */
export function historyFromEvents(events: readonly SessionEvent[]): {
  messages: Message[];
  toolCalls: RestoredToolCall[];
} {
  const messages: Message[] = [];
  let toolCalls: RestoredToolCall[] = [];
  for (const event of events) {
    switch (event.type) {
      case "user-transcript.committed":
      case "agent-transcript.committed": {
        // The same one rule the model's own view reads, so a phrase skipped
        // there and kept here would slide every tool-call ANCHOR below by one.
        const message = historyMessageOf(event);
        if (message) messages.push(message);
        break;
      }
      case "tool.called":
        toolCalls.push({
          callId: event.toolCallId,
          name: event.toolName,
          args: event.args,
          status: "pending",
          // The message it followed, as of now — which is why this has to be the
          // same walk that builds `messages`.
          afterMessageIndex: messages.length - 1,
        });
        break;
      case "tool.completed": {
        const call = toolCalls.find((c) => c.callId === event.toolCallId);
        if (call) {
          call.status = "done";
          call.result = event.result;
        }
        break;
      }
      case "session.reset":
        // Both, for the reason `messagesFromEvents` gives for one: a reset
        // discarded the conversation, and a tool call belonging to it is no more
        // part of the current one than a turn is.
        messages.length = 0;
        toolCalls = [];
        break;
      default:
        break;
    }
  }
  // The same front trim, and the anchors move WITH it. A tool call whose anchor
  // slid out of the window is not dropped — it re-anchors to `-1` and renders
  // before all messages, which is exactly what the live client does when its own
  // window slides past an anchor.
  const dropped = Math.max(0, messages.length - DEFAULT_MAX_HISTORY);
  if (dropped > 0) messages.splice(0, dropped);
  for (const call of toolCalls) {
    call.afterMessageIndex = Math.max(-1, call.afterMessageIndex - dropped);
  }
  return { messages, toolCalls: toolCalls.slice(-DEFAULT_MAX_HISTORY) };
}
