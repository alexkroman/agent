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
import { MAX_CLIENT_MESSAGES } from "@alexkroman1/aai/internal";
import type { RestoredToolCall } from "@alexkroman1/aai/protocol";
import type { ModelMessage } from "ai";
import {
  estimateConversationTokens,
  evictBeyondRetention,
  HISTORY_RETAIN_TOKENS,
} from "./_history-retention.ts";
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
  // Spoken but deliberately unrecorded: a failure phrase, or a `say` with
  // `record: false`. See the event's own doc in `sdk/protocol-events.ts`.
  if (event.recovery !== undefined || event.recorded === false) return undefined;
  return { role: "assistant", content: event.text };
}

/**
 * The conversation these events record, oldest first and retained like the
 * live session's own record — {@link historyFromEvents}' messages, without its
 * anchors.
 *
 * ONE walk, not a second one that agrees with it: the two used to be separate
 * loops over the same events with the same reset rule and the same front trim
 * written twice, which is the shape the module doc above spends a section on.
 *
 * @internal
 */
export function messagesFromEvents(
  events: readonly SessionEvent[],
  opts: HistoryFromEventsOptions = {},
): Message[] {
  return historyFromEvents(events, opts).messages;
}

/** Options for {@link historyFromEvents}. @internal */
export interface HistoryFromEventsOptions {
  /**
   * Estimated tokens of conversation retained — the live record's own memory
   * bound (`_history-retention.ts`), default `HISTORY_RETAIN_TOKENS`. A spec
   * lowers it, as it lowers the live one, to reach the bound.
   */
  retainTokens?: number;
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
export function historyFromEvents(
  events: readonly SessionEvent[],
  opts: HistoryFromEventsOptions = {},
): {
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
  // Retained at the FRONT exactly as the live record is (`_history-retention.ts`,
  // in TOKENS): a resumed session must not come back holding more than it could
  // have kept without dropping. The full log stays the source of truth; this is
  // only what a session REMEMBERS of it.
  const removed = evictBeyondRetention(
    messages,
    opts.retainTokens ?? HISTORY_RETAIN_TOKENS,
    estimateConversationTokens,
  );
  return { messages, toolCalls: shiftAnchors(toolCalls, removed) };
}

/**
 * Move the anchors with a front trim, by the number of VISIBLE messages that
 * came off rather than by the raw count — they index that subsequence. A tool
 * call whose anchor slid out of the window is not dropped: it re-anchors to
 * `-1` and renders before all messages, which is exactly what the live client
 * does when its own window slides past an anchor. Mutates the calls in place,
 * which are the walk's own.
 */
function shiftAnchors(
  toolCalls: RestoredToolCall[],
  removed: readonly Message[],
): RestoredToolCall[] {
  const droppedVisible = removed.reduce((n, m) => (m.role === "tool" ? n : n + 1), 0);
  if (droppedVisible === 0) return toolCalls;
  for (const call of toolCalls) {
    call.afterMessageIndex = Math.max(-1, call.afterMessageIndex - droppedVisible);
  }
  return toolCalls;
}

/**
 * What a `history.restored` frame carries of a restored conversation: the last
 * `MAX_CLIENT_MESSAGES` VISIBLE messages and tool calls, anchors moved with the
 * trim.
 *
 * The one place a message COUNT survives, and it is a display/wire bound: the
 * frame's schema caps both arrays at it, and the browser keeps no more in its
 * snapshot. What the session remembers is the token-retained `messages` this
 * is cut from, untouched.
 *
 * @internal
 */
export function clientHistoryFrame(
  messages: readonly Message[],
  toolCalls: readonly RestoredToolCall[],
): {
  messages: { role: "user" | "assistant"; content: string }[];
  toolCalls: RestoredToolCall[];
} {
  const visible = messages.flatMap((m) =>
    m.role === "tool" ? [] : [{ role: m.role, content: m.content }],
  );
  const dropped = Math.max(0, visible.length - MAX_CLIENT_MESSAGES);
  return {
    messages: visible.slice(dropped),
    toolCalls: toolCalls.slice(-MAX_CLIENT_MESSAGES).map((call) => ({
      ...call,
      afterMessageIndex: Math.max(-1, call.afterMessageIndex - dropped),
    })),
  };
}

/**
 * How much of one prior tool RESULT a rebuilt model history repeats, in
 * characters. A seeded result is a reminder of what the call answered — enough
 * that the model does not re-call the tool to answer "what was the weather
 * again" — not the payload itself, which `ctx.messages` still holds in full
 * (capped only by `MAX_TOOL_RESULT_CHARS`) for a tool that reads it.
 */
export const SEEDED_TOOL_RESULT_CHARS = 240;

/**
 * The same cap for a seeded call's ARGUMENTS, measured as their JSON. Over it,
 * each string argument is cut to {@link SEEDED_TOOL_ARG_VALUE_CHARS}; still over
 * (a deeply nested or many-keyed call), the input is sent as `{}`.
 *
 * Arguments are STRUCTURED here, not text, so they cannot be clipped mid-JSON
 * the way the old digest line was: the tool-call part's `input` goes to the
 * provider as the call's argument object, and a string that is not the JSON of
 * one would be a malformed call in the model's own history.
 */
export const SEEDED_TOOL_ARGS_CHARS = 160;

/** Each string argument's length once a call's arguments are over {@link SEEDED_TOOL_ARGS_CHARS}. */
export const SEEDED_TOOL_ARG_VALUE_CHARS = 40;

/**
 * The longest tool-call id a seeded pair carries. OpenAI refuses a
 * `tool_calls[].id` over 40 characters, and it is the tightest of the providers
 * a rebuilt history may be sent to — the log's id was minted by whichever
 * provider ran the ORIGINAL turn, which is not necessarily this session's.
 */
export const MAX_SEEDED_TOOL_CALL_ID_CHARS = 40;

/** `text` cut to `max` characters, saying so when it was. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (truncated)`;
}

/**
 * A prior result as the model is handed it again — {@link SEEDED_TOOL_RESULT_CHARS}.
 * Exported for the client-history budget, which charges a completion what the
 * model will actually read of it.
 *
 * @internal
 */
export function seededToolResult(result: string): string {
  return clip(result, SEEDED_TOOL_RESULT_CHARS);
}

/** A prior call's arguments, capped — see {@link SEEDED_TOOL_ARGS_CHARS}. */
function seededToolInput(args: Record<string, unknown>): Record<string, unknown> {
  const fits = (value: Record<string, unknown>): boolean =>
    (JSON.stringify(value)?.length ?? 0) <= SEEDED_TOOL_ARGS_CHARS;
  if (fits(args)) return args;
  const clipped = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "string" ? clip(value, SEEDED_TOOL_ARG_VALUE_CHARS) : value,
    ]),
  );
  return fits(clipped) ? clipped : {};
}

/**
 * The id a seeded pair's two halves share: the log's own `callId` when every
 * provider accepts it, else one derived from it.
 *
 * Anthropic requires `^[a-zA-Z0-9_-]+$` and OpenAI at most
 * {@link MAX_SEEDED_TOOL_CALL_ID_CHARS} characters, and neither is a promise the
 * log makes — ids come from whatever minted them (a provider, a test's fake, an
 * S2S service). The derivation is deterministic (same log, same ids) and
 * `ordinal` makes it unique within one history, which matters because a
 * client's history spans several sessions and two of them may reuse an id.
 */
function seededCallId(callId: string, ordinal: number, taken: Set<string>): string {
  const safe = callId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_SEEDED_TOOL_CALL_ID_CHARS);
  const id =
    safe === callId && safe.length > 0 && !taken.has(safe)
      ? safe
      : `seed_${ordinal}_${safe}`.slice(0, MAX_SEEDED_TOOL_CALL_ID_CHARS);
  taken.add(id);
  return id;
}

/**
 * The MODEL's view of a rebuilt history: {@link historyFromEvents}' messages as
 * AI SDK {@link ModelMessage}s, with every prior tool call seeded as the REAL
 * pair a live turn leaves — an assistant message carrying the `tool-call` part,
 * then a `tool` message carrying its `tool-result` under the same id — followed
 * by the reply the assistant spoke after it.
 *
 * ```text
 * user       "weather in Portland?"
 * assistant  [tool-call c1 weather {"city":"Portland"}]
 * tool       [tool-result c1 weather text '{"temp":12}']
 * assistant  "Twelve degrees."
 * ```
 *
 * That is the shape `streamText`'s own step messages have
 * (`transports/pipeline-history.ts`, `pushLlm`), so a resumed or reloaded
 * conversation reads to the model exactly as it would have had the session
 * never dropped. `ctx.messages` is untouched by this: it keeps the
 * `role: "tool"` messages, which is what a tool reads.
 *
 * ## Why pairs, and not the text digest this used to render
 *
 * This used to fold each call into the ASSISTANT's text as a line,
 * `[tool think({"thought":"…"}) → …]`, because the event log holds a call's two
 * halves in two events and a `tool` message seeded alone is an orphan both
 * providers reject. It kept the request valid and the call in memory, and it
 * taught the model a FORMAT: text in its own turns that looked like a tool
 * call. Seen live on the AssemblyAI gateway (gpt-5.6-luna, reasoning off), a
 * later turn spoke `[tool think({"thought":"…"}) … to=functions.prepare_call …
 * {"callee":…}` as its REPLY — its own tool-call channel markup leaking into
 * the text it had been shown was its own — with no `tool.called` behind it, so
 * the call never ran and the caller heard gibberish and saw nothing happen. A
 * model imitates its own history; the history must therefore contain only
 * things it would really have produced.
 *
 * The orphan problem is solved the direct way instead: a pair is built only
 * from BOTH halves — the `tool` message (its result) and the
 * {@link RestoredToolCall} with the same `callId` (its name and arguments).
 *
 * ## A call with only one half is DROPPED, not described
 *
 * The log's front is trimmed, so a long conversation can hold a completion
 * whose `tool.called` is gone (no name, no arguments), and a pending call has no
 * result. Neither is rendered at all — no text mention, however phrased, since
 * any sentence about a call is one more thing in the assistant's turns shaped
 * like one. What is lost is a call at the very edge of the window, which the
 * front trim was already discarding.
 *
 * Results and arguments are capped ({@link SEEDED_TOOL_RESULT_CHARS},
 * {@link SEEDED_TOOL_ARGS_CHARS}) and ids made provider-safe
 * ({@link seededCallId}). A later trim — the 200-message cap or the per-request
 * token budget — can only cut this list at the FRONT, and both heal the one
 * shape that makes (a leading `tool` message); `PipelineHistory.seed` re-pairs
 * the whole list on the way in besides.
 *
 * @internal
 */
export function modelHistoryOf(
  messages: readonly Message[],
  toolCalls: readonly RestoredToolCall[],
): ModelMessage[] {
  const byId = new Map(toolCalls.map((call) => [call.callId, call]));
  const taken = new Set<string>();
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role !== "tool") {
      out.push(
        m.role === "user"
          ? { role: "user", content: m.content }
          : { role: "assistant", content: m.content },
      );
      continue;
    }
    const call = m.toolCallId === undefined ? undefined : byId.get(m.toolCallId);
    // One half only — see "A call with only one half is DROPPED".
    if (call === undefined) continue;
    const toolCallId = seededCallId(call.callId, out.length, taken);
    out.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId,
            toolName: call.name,
            input: seededToolInput(call.args),
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: call.name,
            // What `streamText` records for a tool whose `execute` returned a
            // string, which every tool here does (`to-vercel-tools.ts`).
            output: { type: "text", value: seededToolResult(m.content) },
          },
        ],
      },
    );
  }
  return out;
}
