// Copyright 2026 the AAI authors. MIT license.
/**
 * A TEXT agent's turns as a typed {@link SessionEvent} stream.
 *
 * ## Why this exists at all
 *
 * A voice session's whole observable behaviour is a list of typed events, and
 * every claim the eval tier makes is read off it — `eval/events.ts` says so in
 * its own doc: *"No log scraping, no provider internals, no reaching into the
 * transport."* `createTextAgent` emitted nothing, so a caller grading a text
 * agent had only the vendor's `StreamTextResult` and whatever text it could
 * scrape out of it.
 *
 * Be precise about what that cost, because the obvious answer is wrong and this
 * doc gave it for one commit. `packages/aai-evals/src/studio-target.ts` grades
 * the studio's coding agent — an ordinary `agent({ text: true })` definition —
 * with five regexes over tool output, and **those five survive this module**:
 * they classify a tool result's TEXT, and an event carries that same string
 * (`tool.completed.result`) rather than a parsed verdict. Retiring them wants
 * STRUCTURED tool results, which is a change in `aai-guest`. The correlation an
 * event stream does own — which result belongs to which call, in what order —
 * that target already got from `readUIMessageStream`.
 *
 * What a missing event stream actually cost is that a text agent could not be
 * DRIVEN by a harness at all: no terminator to wait on, so no `send()` that
 * cannot begin inside the previous turn, and no typed vocabulary for the claims
 * a case makes. `eval/text-agent.ts` is what this unlocks;
 * `packages/aai-evals/CLAUDE.md` carries the full accounting of which of the
 * five could and could not be replaced.
 *
 * ## It is the SAME union, narrowed — not a parallel vocabulary
 *
 * Of the eighteen members of {@link SessionEvent}, all but five are mode-neutral
 * facts ("this tool was called with these arguments", "this reply ended"), and a
 * text agent has honest instances of seven of them. So this emits `SessionEvent`
 * itself, and the payoff is that every reader above it works UNCHANGED:
 * `toolCallsInEvents`, `toolNames`, `toolArgsIn`, `toolResultIn`, `saidIn`,
 * `customEventsIn`, `describeToolCalls` and `TURN_ENDS` — and the whole
 * `aai-evals` assertion vocabulary built on them — take a text agent's stream
 * with no second implementation. A `TextAgentEvent` union of its own would mean
 * a second set of readers and a second set of assertions, which then drift; the
 * one thing worse than an un-gradeable agent is two vocabularies that disagree
 * about what a tool call is.
 *
 * What is emitted, and only this:
 *
 * | Event | When |
 * | --- | --- |
 * | `user-transcript.committed` | the turn opens, when the conversation ends in a user message |
 * | `tool.called` | one tool invocation, with its name and arguments |
 * | `tool.completed` | that call's serialized result — a failure included |
 * | `agent-transcript.committed` | the reply's full text, on a turn that finished |
 * | `reply.completed` / `reply.cancelled` | the turn's terminator, exactly one |
 * | `error.reported` | the model stream failed (`llm`), or a tool THREW (`tool`) |
 * | `custom.emitted` | `ctx.send` from a tool body |
 *
 * ### The eleven that are not, each for a stated reason
 *
 * Six are speech and have no text analogue at all: `speech.started`,
 * `speech.stopped`, `audio.completed`, `user-transcript.updated` (there is no
 * interim — a typed message arrives whole), `session.timed-out` (no idle timer)
 * and `session.reset` (no reset command; a text agent's conversation is the
 * `messages` its caller passes).
 *
 * `state.updated` and `history.restored` describe machinery a text agent does
 * not have — a `syncState` projection is pushed by the runtime's session, and a
 * restore frame is what a RESUME sends, where a text agent has no resume path
 * (see `createTextAgent`'s note on its detached slot store).
 *
 * **`session.configured` is the one member refused for want of an honest
 * field**, and it is worth stating plainly because it is the shape of mistake
 * this module must not make. It requires `audioFormat`, `sampleRate` and
 * `ttsSampleRate`; a text agent has no audio path, `0` fails the schema's
 * `positive()`, and any real number is a lie a client would negotiate against.
 * A synthesized field is worse than an absent event, because an assertion will
 * believe it. Its one useful payload, the session id, is on the handle
 * (`TextAgent.sessionId`) where a caller already has it.
 *
 * `agent-transcript.updated` is the deliberate omission that is NOT about
 * honesty: a per-delta snapshot would be truthful and is simply redundant here.
 * `text-agent.ts` returns the vendor's `StreamTextResult` precisely so a chat
 * surface consumes `textStream`, so the interim text is already in the caller's
 * hands, and the readers assert on committed text on purpose — *"a delta is a
 * draft"*. Emitting it would double every reply's bytes through a second
 * channel to serve nobody. Adding it later is additive.
 *
 * ## The terminator fires exactly once, and that is the load-bearing property
 *
 * `TURN_ENDS` is how a harness waits for a reply to END rather than for a timer
 * (`eval/session.ts`'s `say()`), so a follow-on `send()` is deterministic only
 * if every turn emits one terminator and never two. Two things make that true:
 *
 * - **One SOURCE.** Both terminators are derived from the stream's own terminal
 *   part — `finish`, `abort` or `error`, all three delivered through the single
 *   `onChunk` callback — rather than from three sibling callbacks (`onEnd`,
 *   `onAbort`, `onError`) whose relative order a caller would have to reason
 *   about. One ordered stream cannot race itself.
 * - **A guard, first one wins.** An `abort` after an `error`, or the `finish`
 *   the SDK may still enqueue behind either, is a no-op. The guard is what makes
 *   the claim hold rather than the argument above, which is why it is there.
 *
 * {@link TextTurnEventHooks.onEnd} is a BACKSTOP for the one case the terminal
 * part does not cover: the AI SDK does not itself assume a `finish` part arrived
 * (`recordedFinishReason != null ? … : "other"` in its own flush), and a turn
 * that recorded steps and then closed without one would otherwise leave a
 * harness waiting out its timeout. It is guarded by the same flag, so on every
 * ordinary turn it is already spent by the time it runs.
 *
 * An ABORTED or FAILED turn commits no transcript. That is the voice rule
 * verbatim — *"this event fires once per reply that is recorded, and never for
 * one that was interrupted"* — and keeping it is what makes `saidIn` mean the
 * same thing in both modes. A caller that wants the partial text has it in
 * `textStream` and in `steps`; an eval that read a fragment as the reply would
 * be asserting on text no caller was ever given in full.
 *
 * ## Two things a text agent's tools could do and could not report
 *
 * `ctx.send` and an uncaught tool throw both reach `executeToolCall` as
 * optional callbacks (`send`, `onUncaught`), and `text-agent.ts` passed neither
 * — so a tool's `ctx.send` was silently dropped and a tool that THREW produced
 * one `logger.warn`. Both are wired here, through the same
 * {@link decideClientEvent} the session path uses, so a payload this drops is a
 * payload a session would drop too and a spec cannot assert a send that
 * production loses.
 *
 * ## No index, no retention, and therefore no second id
 *
 * These events are stamped ({@link stampSessionEvent}) and handed to a callback.
 * They take no index and are not appended to a retained stream, because a text
 * agent has none — it is not a session, `createRuntime` refuses one. That is the
 * same case host-mode's handshake rejection is stamped for. It also means the
 * wire's `.max()` on a committed transcript is not the binding constraint on
 * this path: nothing here crosses a socket, and truncating what the agent said
 * would make `saidIn` lie about a long reply. A consumer that forwards these
 * onto a wire caps them itself. Tool results ARE capped, through the same
 * `capToolResult` the session path uses, since that cap is what the model was
 * handed in the first place.
 *
 * @module
 */

import {
  capToolResult,
  clientEventDropMessage,
  decideClientEvent,
  toArgsRecord,
} from "@alexkroman1/aai/internal";
import type { SessionEvent, SessionEventBody } from "@alexkroman1/aai/protocol";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { ModelMessage, StreamTextOnChunkCallback, TextStreamPart, ToolSet } from "ai";
import type { Logger } from "./runtime-config.ts";
import { stampSessionEvent } from "./session-event-stream.ts";

/** What a text agent reports, one stamped event at a time. */
export type TextAgentEventHandler = (event: SessionEvent) => void;

/**
 * The two `streamText` hooks one turn installs.
 *
 * Handed back as the vendor's own callback types rather than as a recorder this
 * module invents, so `text-agent.ts` spreads them into the request and owns no
 * translation layer of its own.
 */
export type TextTurnEventHooks = {
  /** Every stream part, which is where all seven events come from. */
  readonly onChunk: StreamTextOnChunkCallback<ToolSet>;
  /** Backstop terminator — see the module doc. Guarded, so usually a no-op. */
  readonly onEnd: () => void;
};

/** One text agent's event surface, for the whole of its conversation. */
export type TextAgentEvents = {
  /**
   * `ctx.send` from a tool body, subject to the session path's own caps.
   *
   * Conversation-scoped rather than turn-scoped because the tool dispatcher is:
   * `createToolDispatcher` is built once per text agent and a dispatched call
   * carries no turn identity, so there is nothing to route a per-turn callback
   * by. See `TextAgentOptions.onEvent` for what that costs a caller running two
   * turns at once.
   */
  readonly custom: (event: string, data: unknown) => void;
  /** A tool that THREW rather than returning a failure — `executeToolCall`'s `onUncaught`. */
  readonly toolFault: (message: string) => void;
  /**
   * Open one turn: emit its user transcript and hand back its hooks.
   *
   * `undefined` when nobody is listening, which is what keeps a text agent with
   * no `onEvent` from installing an `onChunk` at all — the callback pauses the
   * SDK's stream processing until it returns, so an unobserved turn should not
   * be paying for one per part.
   */
  readonly openTurn: (messages: readonly ModelMessage[]) => TextTurnEventHooks | undefined;
};

/** The inert surface a text agent with no `onEvent` gets. */
const NO_EVENTS: TextAgentEvents = {
  custom: () => {
    // Nothing is listening. Inert rather than absent, so `createTextAgent` has
    // one wiring and not two — the branch it would otherwise carry is the shape
    // that leaves a capability wired on one path and dropped on the other.
  },
  toolFault: () => {
    // As above.
  },
  openTurn: () => undefined,
};

/**
 * Build the event surface for one text agent.
 *
 * @param onEvent - Where events go. Absent yields an inert surface, so the
 *   caller has no branch of its own and an unobserved agent costs nothing.
 * @param logger - For the one thing that is reported and not emitted: a
 *   `ctx.send` the wire caps drop.
 *
 * @internal
 */
export function createTextAgentEvents(
  onEvent: TextAgentEventHandler | undefined,
  logger: Logger,
): TextAgentEvents {
  if (onEvent === undefined) return NO_EVENTS;
  const emit = (body: SessionEventBody): void => {
    onEvent(stampSessionEvent(body));
  };
  return {
    custom(event: string, data: unknown): void {
      // The session path's decision, not a second copy of it: the caps are a
      // property of the event rather than of the transport under it, and a
      // spec must not be able to assert a send a deployment would lose.
      const decision = decideClientEvent(event, data);
      if ("drop" in decision) {
        logger.warn?.(clientEventDropMessage(event, decision.drop));
        return;
      }
      emit({ type: "custom.emitted", event, data });
    },
    toolFault(message: string): void {
      // Non-fatal by construction: the model is handed the failure and the turn
      // continues, so this frame is for whoever is watching. `tool` is the code
      // the SDK reserves for exactly this and had no emitter in text mode.
      emit({ type: "error.reported", code: "tool", message, fatal: false });
    },
    openTurn(messages: readonly ModelMessage[]): TextTurnEventHooks {
      return openTurn(emit, messages);
    },
  };
}

/** One turn's recorder: the terminator guard, the text accumulator, the map. */
function openTurn(
  emit: (body: SessionEventBody) => void,
  messages: readonly ModelMessage[],
): TextTurnEventHooks {
  const prompt = trailingUserText(messages);
  if (prompt !== undefined) emit({ type: "user-transcript.committed", text: prompt });

  let said = "";
  let ended = false;

  /** The turn's one terminator. First call wins; every later one is a no-op. */
  const end = (terminator: "reply.completed" | "reply.cancelled"): void => {
    if (ended) return;
    ended = true;
    // Committed only on a turn that FINISHED, and only when it said something:
    // the voice rule, kept so `saidIn` means one thing in both modes.
    if (terminator === "reply.completed" && said !== "") {
      emit({ type: "agent-transcript.committed", text: said });
    }
    emit({ type: terminator });
  };

  const onChunk: StreamTextOnChunkCallback<ToolSet> = ({ chunk }) => {
    handleChunk(chunk, emit, {
      say: (text) => {
        said += text;
      },
      end,
      ended: () => ended,
    });
  };
  return { onChunk, onEnd: () => end("reply.completed") };
}

/** What {@link handleChunk} needs of the turn it belongs to. */
type TurnState = {
  readonly say: (text: string) => void;
  readonly end: (terminator: "reply.completed" | "reply.cancelled") => void;
  readonly ended: () => boolean;
};

/**
 * Map one stream part onto the AGENT's vocabulary.
 *
 * The mapping is deliberately narrow — five of the SDK's twenty-five part kinds
 * — and every case is an agent-level fact rather than a forwarded chunk kind: a
 * `tool.called` is one invocation with its arguments, which is what the
 * `tool-call` part already is, and the `tool-input-*` deltas that assemble it
 * are not events about the agent at all.
 */
function handleChunk(
  chunk: TextStreamPart<ToolSet>,
  emit: (body: SessionEventBody) => void,
  turn: TurnState,
): void {
  switch (chunk.type) {
    case "text-delta":
      turn.say(chunk.text);
      return;
    case "tool-call":
      // `toArgsRecord` for the reason the pipeline uses it: an unrepairable
      // call surfaces with its raw argument STRING as `input`, and the wire
      // schema wants a record — so one bad call degrades to empty arguments
      // instead of an event a reader cannot parse.
      emit({
        type: "tool.called",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        args: toArgsRecord(chunk.input),
      });
      return;
    case "tool-result":
      emit({
        type: "tool.completed",
        toolCallId: chunk.toolCallId,
        result: capToolResult(resultText(chunk.output)),
      });
      return;
    case "tool-error":
      // A completion, not an `error.reported`: `executeToolCall` shapes a
      // failure as a result the model reads, and a call the SDK failed before
      // reaching it (an unrepairable input, an unknown name) is the same fact
      // from one step earlier. Reporting it as a call that never returned
      // instead would be a finding the readers state — and a false one.
      emit({
        type: "tool.completed",
        toolCallId: chunk.toolCallId,
        result: capToolResult(errorMessage(chunk.error)),
      });
      return;
    case "error":
      // Terminal by construction: retries happen under the provider call and
      // emit no part, so an `error` part is a turn the SDK could not finish.
      if (turn.ended()) return;
      emit({
        type: "error.reported",
        code: "llm",
        message: errorMessage(chunk.error),
        // The AGENT survives — the caller may stream another turn on it — so
        // this is a turn-level failure, which is what `fatal: false` says.
        fatal: false,
      });
      turn.end("reply.cancelled");
      return;
    case "abort":
      turn.end("reply.cancelled");
      return;
    case "finish":
      turn.end("reply.completed");
      return;
    default:
      return;
  }
}

/**
 * A tool result as the wire carries it: a string.
 *
 * `executeToolCall` already serializes every result this SDK's own tools
 * produce, so the string branch is the ordinary one; a dynamic or vendor tool
 * can still answer a value, and `JSON.stringify` answers `undefined` for a
 * function or a symbol, which is why there is a third fallback rather than an
 * `event.result` that reads `"undefined"`.
 */
function resultText(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output) ?? String(output);
}

/**
 * The user text this turn was prompted by, if it was prompted by one.
 *
 * The TRAILING user message only. A text turn is handed the whole conversation
 * rather than one utterance, so committing every user message would re-emit the
 * conversation on every turn — the log would grow quadratically and a reader
 * counting user turns would count wrong. The trailing message is the one fact
 * the turn adds, and a conversation that ends in an assistant or tool message
 * (a continuation) adds none, so it emits nothing rather than guessing.
 *
 * Text parts only, joined, which is the projection `ctx.messages` already
 * promises a tool: an image has no string form that belongs in a transcript.
 */
function trailingUserText(messages: readonly ModelMessage[]): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== "user") return undefined;
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  return text === "" ? undefined : text;
}
