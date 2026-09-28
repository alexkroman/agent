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
 * ## Two events for a TRANSCRIPT, and only two
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
 * ## And `tool.completed` is the THIRD event, for the `"tool"` arm
 *
 * A settled tool call contributes a `role: "tool"` message, so a resumed
 * session hands a tool the same history a live one does — what earlier tools in
 * the conversation answered. It is deliberately NOT part of
 * {@link historyMessageOf}: that rule is shared with `session-core.ts`'s live
 * dispatch, which sees the pipeline's own `tool.completed` reports for a
 * session whose tools already recorded their results at the call site
 * (`to-vercel-tools.ts`), and appending there would record every pipeline
 * result twice. The live producers and this one agree by sharing
 * {@link toolResultMessage} and the string the EVENT carries, rather than by
 * sharing a dispatch.
 *
 * A call with no `tool.completed` contributes nothing, for the same reason it
 * stays `pending` below: no result exists to report.
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

import type { Message, SessionEvent, SessionEventBody } from "@alexkroman1/aai";
import { DEFAULT_MAX_HISTORY } from "@alexkroman1/aai/internal";
import type { RestoredToolCall } from "@alexkroman1/aai/protocol";
import { toolResultMessage } from "./_tool-result-message.ts";

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
 * session's own window — {@link historyFromEvents}' messages, without its
 * anchors.
 *
 * ONE walk, not a second one that agrees with it: the two used to be separate
 * loops over the same events with the same reset rule and the same front trim
 * written twice, which is the shape the module doc above spends a section on.
 *
 * @internal
 */
export function messagesFromEvents(events: readonly SessionEvent[]): Message[] {
  return historyFromEvents(events).messages;
}

/**
 * The conversation AND the tool calls interleaved through it — one walk, so the
 * anchors cannot disagree with the messages they point at.
 *
 * The messages are what a resumed session remembers: the transcripts, plus a
 * `role: "tool"` message per settled call, so a tool reads the same history
 * here as it does live (see the module doc's third section). The tool calls are
 * for the CLIENT: `ToolCallInfo` blocks render inside the transcript, anchored
 * to the message they followed, and without them a resumed conversation comes
 * back as plain dialogue with every "looked up your order" row missing — which
 * reads as the agent having done less than it did.
 *
 * **The anchor is an INDEX into the VISIBLE messages — the transcripts, in
 * order, with the `"tool"` ones subtracted.** That is the list the client
 * receives: `session-core.ts`'s `restoreHistory` filters this array to
 * `user`/`assistant` before it goes on the wire, because `history.restored`
 * renders dialogue and carries the tool calls separately. Counting the tool
 * messages here too would slide every row down by the number of results ahead
 * of it, which is silent (the frame still validates) and shows a resumed call's
 * tool rows under the wrong turns. Never an id: the client mints
 * `ChatMessage.id` itself as a render key, so an id chosen here would be a
 * second numbering scheme over one list. `-1` means "before any message", which
 * is the same sentinel the live path uses.
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
  // The anchors' coordinate space — see the doc above. Maintained beside the
  // array rather than derived from it, because deriving it means filtering the
  // whole list once per `tool.called`.
  let visible = 0;
  for (const event of events) {
    switch (event.type) {
      case "user-transcript.committed":
      case "agent-transcript.committed": {
        // The same one rule the model's own view reads, so a phrase skipped
        // there and kept here would slide every tool-call ANCHOR below by one.
        const message = historyMessageOf(event);
        if (message) {
          messages.push(message);
          visible++;
        }
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
          afterMessageIndex: visible - 1,
        });
        break;
      case "tool.completed": {
        const call = toolCalls.find((c) => c.callId === event.toolCallId);
        if (call) {
          call.status = "done";
          call.result = event.result;
        }
        // Recorded even when no `tool.called` survives to name the tool: the
        // log's front is trimmed, so a long conversation can hold a completion
        // whose call is gone, and the RESULT is the half a tool reads. Absent
        // rather than guessed — `Message.toolName` says to read the arm by role.
        messages.push(
          toolResultMessage({
            result: event.result,
            toolName: call?.name,
            toolCallId: event.toolCallId,
          }),
        );
        break;
      }
      case "session.reset":
        // Both, for the reason a reset gives for either: a reset discarded the
        // conversation, and a tool call belonging to it is no more part of the
        // current one than a turn is.
        messages.length = 0;
        toolCalls = [];
        visible = 0;
        break;
      default:
        break;
    }
  }
  // Trimmed at the FRONT, matching the live window (`DEFAULT_MAX_HISTORY`): a
  // resumed session must not come back holding more context than it could have
  // accumulated without dropping. The anchors move WITH it, by the number of
  // VISIBLE messages that came off rather than by the raw count — they index
  // that subsequence. A tool call whose anchor slid out of the window is not
  // dropped: it re-anchors to `-1` and renders before all messages, which is
  // exactly what the live client does when its own window slides past an anchor.
  const dropped = Math.max(0, messages.length - DEFAULT_MAX_HISTORY);
  if (dropped > 0) {
    const removed = messages.splice(0, dropped);
    const droppedVisible = removed.reduce((n, m) => (m.role === "tool" ? n : n + 1), 0);
    for (const call of toolCalls) {
      call.afterMessageIndex = Math.max(-1, call.afterMessageIndex - droppedVisible);
    }
  }
  return { messages, toolCalls: toolCalls.slice(-DEFAULT_MAX_HISTORY) };
}

/**
 * How much of one prior tool RESULT a rebuilt model history repeats, in
 * characters. A digest is a reminder that the call happened and roughly what it
 * said — enough that the model does not re-call the tool to answer "what was
 * the weather again" — not the payload itself, which `ctx.messages` still holds
 * in full for a tool that reads it.
 */
export const TOOL_DIGEST_RESULT_CHARS = 240;

/** The same cap for a digest's ARGUMENTS, which are usually far shorter. */
export const TOOL_DIGEST_ARGS_CHARS = 160;

/** `text` cut to `max` characters, saying so when it was. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (truncated)`;
}

/**
 * One prior tool call as a line of text: `[tool weather({"city":"Portland"}) →
 * {"temp":12}]`. The name is absent when the log's front no longer holds the
 * `tool.called` — the result is still worth repeating.
 *
 * @internal
 */
export function toolDigest(call: {
  name?: string | undefined;
  args?: unknown;
  result: string;
}): string {
  const args =
    call.args === undefined ? "" : clip(JSON.stringify(call.args) ?? "", TOOL_DIGEST_ARGS_CHARS);
  return `[tool ${call.name ?? "(unknown)"}(${args}) → ${clip(call.result, TOOL_DIGEST_RESULT_CHARS)}]`;
}

/**
 * The MODEL's view of a rebuilt history: {@link historyFromEvents}' messages
 * with every `role: "tool"` one folded into the assistant side as a
 * {@link toolDigest}.
 *
 * ## Why a digest and not the tool message
 *
 * The pipeline's LLM view holds tool-call PAIRS — an assistant message carrying
 * the call and a `tool` message answering it — and the event log records only
 * the result half, so a `tool` message seeded alone is an orphan both providers
 * reject (`transports/pipeline-history.ts` has the error strings). `seed` used
 * to answer that by DROPPING them, which kept the request valid and silently
 * lost every tool call from the model's memory of a resumed or reloaded
 * conversation: an agent that had looked up an order asked for the order number
 * again. Rendering the call as text on the ASSISTANT side keeps both properties
 * — there is no pair to orphan, and the model reads what it did.
 *
 * The digest is PREPENDED to the assistant reply that followed the call (that
 * is where the model produced it), and a call with no reply after it — a turn
 * that ended mid-chain, or the log's last word — becomes an assistant message
 * of its own. `ctx.messages` is untouched by this: it keeps the real `tool`
 * messages, which is what a tool reads.
 *
 * @internal
 */
export function modelHistoryOf(
  messages: readonly Message[],
  toolCalls: readonly RestoredToolCall[],
): Message[] {
  const byId = new Map(toolCalls.map((call) => [call.callId, call]));
  const out: Message[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    out.push({ role: "assistant", content: pending.join("\n") });
    pending = [];
  };
  for (const m of messages) {
    if (m.role === "tool") {
      const call = m.toolCallId === undefined ? undefined : byId.get(m.toolCallId);
      pending.push(
        toolDigest({ name: m.toolName ?? call?.name, args: call?.args, result: m.content }),
      );
      continue;
    }
    if (m.role === "assistant" && pending.length > 0) {
      out.push({ role: "assistant", content: `${pending.join("\n")}\n${m.content}` });
      pending = [];
      continue;
    }
    flush();
    out.push({ role: m.role, content: m.content });
  }
  flush();
  return out;
}
