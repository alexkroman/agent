// Copyright 2026 the AAI authors. MIT license.
/**
 * Speaking a tool's declared messages — the runtime half of `ToolDef.messages`
 * (`aai/sdk/tool-messages.ts`, which owns the four kinds and the author's view
 * of them, and `tool-messages-select.ts`, which owns the choice).
 *
 * This module owns the three things the declaration cannot state: WHEN each
 * line goes out, what a line may and may not do to the turn around it, and how
 * a verbatim completion takes the model out of the loop.
 *
 * ## A tool message may never cost the caller a reply
 *
 * Every rule here exists because a filler line is agent speech, and this
 * transport has already shipped one bug where that was enough to destroy a
 * turn: the dead-air cover drove `agentIsSpeaking()` true while the agent had
 * said nothing of its own, so a caller's "are you still there?" counted as
 * interrupting the reply and aborted 16.6s of completed work (see "Stop
 * dead-air filler from opening the barge-in gate"). The four properties that
 * keep this feature out of that family:
 *
 * 1. **START and DELAYED are sent `record: false`.** That is the same flag the
 *    dead-air cover rides, and it is what `HeardTracker.spokeRecordable()`
 *    reads — so a turn that has played only tool filler still cannot be spoken
 *    over, and the filler never reaches history, `ctx.messages` or a committed
 *    transcript. Nothing in this module is allowed to send one with
 *    `record: true`; `emitFiller` is the only path either takes.
 * 2. **Nothing here aborts, cancels or races anything.** There is no signal
 *    this module owns, no `tts.cancel()`, no flush, and no promise raced
 *    against the reply. It reads the turn's signal and stops; it never fires
 *    one. The only thing it can delay is the tool call it belongs to, and only
 *    under `blocking`, and only up to {@link TOOL_START_BLOCKING_MAX_MS} —
 *    bounded with `pTimeout` at the call site rather than by trusting the
 *    channel, so a channel that never settles costs one slow call.
 * 3. **A caller who is talking is not talked over.** Every filler send checks
 *    `callerSpeaking()` first, the rule `pipeline-stream-parts.ts` already
 *    applies to the dead-air cover for the same measured reason.
 * 4. **The generic cover stands down while a tool is covering itself**, which
 *    is Vapi's "idle messages are disabled during tool calls" — see
 *    {@link ToolSpeechController.covering}. Without it a tool with a 3s rung
 *    and a session with a 2s dead-air window speak twice about one gap.
 */

import type { RandomSource, ToolMessages } from "@alexkroman1/aai";
import {
  planDelayedLadder,
  selectToolMessage,
  TOOL_START_BLOCKING_MAX_MS,
} from "@alexkroman1/aai/host-internal";
import { sleep } from "@alexkroman1/aai/internal";
import { isToolFailure, omitUndefined, safeJsonParse } from "@alexkroman1/aai/utils";
import pTimeout from "p-timeout";
import { createRestartableTimer } from "./_timer.ts";
import type { Logger } from "./runtime-config.ts";

/**
 * How the runner reaches the caller. Bound per TURN by `consumeLlmStream`,
 * because the coalescer these funnel into is per-turn — see
 * {@link ToolSpeechController.bind}.
 */
export type ToolSpeechChannel = {
  /** Forward text to the turn's TTS funnel, carrying `record` unchanged. */
  send(text: string, opts: { record: boolean }): void;
  /**
   * Release whatever the coalescer is holding.
   *
   * Called before AND after every send here. Before, because a tool call is
   * not guaranteed to have been preceded by the `text-end` that usually
   * releases the buffer — the AI SDK may start `execute` before the consumer
   * has read the `tool-call` part, so the boundary `pipeline-stream-parts.ts`
   * draws on that part may not have happened yet, and a line sent past a
   * buffered fragment would be spoken in the wrong order. After, because
   * nothing else is coming to flush it: the whole point is that the turn has
   * gone quiet.
   */
  boundary(): void;
  /** Accumulate into the turn's TRANSCRIPT. Only a verbatim completion does. */
  record(text: string): void;
  /**
   * Is the caller mid-utterance? Filler declines rather than talking across.
   *
   * **This is the ONLY suppressor, and a `bargeIn` one must not be added
   * beside it.** The two are orthogonal: `bargeIn: "off"` governs whether
   * CALLER speech takes the floor from the agent, where filler governs whether
   * the agent covers its own latency. Suppressing filler inside a no-barge-in
   * state would play dead air during exactly the phase in which the author has
   * declared the agent must keep the floor — the gap this feature exists to
   * close — so such a state wants filler MORE than an ordinary one, not less.
   *
   * The interesting sub-case is already covered by this predicate rather than
   * by a second one: in a no-barge-in state the caller may be talking while
   * the agent continues, `callerSpeaking()` is true there, and declining to
   * add filler on top of a live utterance is right whoever holds the floor —
   * cover is pointless when the line is not actually silent.
   */
  callerSpeaking(): boolean;
  /**
   * Wait for `text` to have been spoken, for a `blocking` start.
   *
   * Deliberately an ESTIMATE rather than a provider acknowledgement, and the
   * default implementation is the only one this repo ships. Waiting on the TTS
   * session would mean flushing it and awaiting `done` mid-turn — touching the
   * lifecycle of the reply in flight, which is precisely the move behind the
   * measured failure where a dead-air probe killed the real reply and the agent
   * went mute for 21-38s. An estimate cannot do that: it observes nothing and
   * signals nothing.
   *
   * **That property is the contract, not the accuracy.** It is a seam so a
   * host can supply a better estimate, and a replacement owes "observes
   * nothing and signals nothing" first: one that subscribes to a provider
   * event, flushes a session, or holds anything the reply's own teardown also
   * holds is a regression however much closer its timing is.
   */
  awaitSpoken(text: string, signal?: AbortSignal): Promise<void>;
};

/**
 * Characters of speech per millisecond of audio, for
 * {@link ToolSpeechChannel.awaitSpoken}'s estimate.
 *
 * The CEILING rather than a typical rate (it is `MAX_SPEECH_CHARS_PER_MS` in
 * `transports/pipeline-heard.ts`, kept in step with it), so the estimate errs
 * SHORT: a blocking start that under-waits releases the tool a beat early,
 * where one that over-waits charges every call for a guess.
 */
const SPEECH_CHARS_PER_MS = 18 / 1000;

/** The estimate behind the default {@link ToolSpeechChannel.awaitSpoken}. */
export function estimateSpokenMs(text: string): number {
  return Math.round(text.length / SPEECH_CHARS_PER_MS);
}

/**
 * What a `role: "system"` completion prepends to its hint inside the tool
 * result the MODEL sees.
 *
 * The hint rides with the result rather than being spliced in as a real system
 * message, and the label is what keeps the two readable apart. A system
 * message would have to be injected through `prepareStep`, whose `messages`
 * slot the context budget owns — two writers on one key, where the value here
 * is guidance about ONE tool result and belongs beside it.
 */
export const TOOL_SYSTEM_HINT_LABEL = "[guidance]";

/** One tool call's messages, for the length of that call. */
export type ToolCallSpeech = {
  /**
   * Speak the START line, if this call draws one. Resolves immediately unless
   * the line is `blocking`, in which case it resolves when the line has been
   * spoken or {@link TOOL_START_BLOCKING_MAX_MS} has passed — whichever is
   * first, and never with a rejection.
   */
  start(): Promise<void>;
  /**
   * The call settled: stop the ladder and say what the outcome says.
   *
   * Returns what the MODEL should be handed, which is the tool's own result
   * unless a `role: "system"` message annotated it. A `role: "assistant"` one
   * is spoken here and latches {@link ToolSpeechController.verbatim}, which is
   * what stops the step loop.
   */
  settled(result: string): string;
  /** Stop the ladder. Idempotent; safe on every path including a throw. */
  dispose(): void;
};

/** Session-scoped owner of every tool call's messages — see the module doc. */
export type ToolSpeechController = {
  /**
   * Bind the current turn's speech channel; the thunk unbinds it.
   *
   * Bound per turn because the TTS coalescer is: sending through a captured
   * one would reach a coalescer belonging to a turn that has ended. With
   * nothing bound every message is a no-op, which is what a text agent, a
   * subagent and a speculation all legitimately get.
   */
  bind(channel: ToolSpeechChannel): () => void;
  /** Start a turn: clears the verbatim latch. */
  beginTurn(): void;
  /** `undefined` when this tool declares no messages — the overwhelming case. */
  begin(
    messages: ToolMessages | undefined,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
  ): ToolCallSpeech | undefined;
  /**
   * Is a tool call covering its own gap right now?
   *
   * True from the moment a call with a START or a DELAYED line begins until it
   * settles, and read by the dead-air cover, which stands down rather than
   * speaking a second line about the same silence. False for a tool that only
   * declares `complete`/`failed` — that call is as silent as any other and the
   * generic cover is exactly what it needs.
   */
  covering(): boolean;
  /**
   * The verbatim completion this turn spoke, if any — and therefore the signal
   * that the model must NOT be called again.
   *
   * `pipeline-llm-stream.ts` reads it twice: once as a `stopWhen` condition, so
   * the step loop ends at this tool result, and once after the stream to append
   * the sentence to the turn's model messages — without which the next turn's
   * model would not know the agent had said it.
   */
  verbatim(): string | undefined;
};

/** Everything {@link createToolSpeechController} needs from its owner. */
export type ToolSpeechDeps = {
  log: Logger;
  sid: string;
  /** Injected so a spec can pin which variant a call draws. */
  random?: RandomSource | undefined;
};

/** A tool result the model should read as a FAILURE — see `serializeToolFailure`. */
function isFailureResult(result: string): boolean {
  return isToolFailure(safeJsonParse(result));
}

export function createToolSpeechController(deps: ToolSpeechDeps): ToolSpeechController {
  const { log, sid } = deps;
  const random = deps.random;
  let channel: ToolSpeechChannel | undefined;
  /** Calls whose START/DELAYED lines are still the cover for this gap. */
  let coveringCalls = 0;
  let verbatim: string | undefined;

  /**
   * The one send filler takes. `record: false` is not a parameter here, which
   * is the point: no argument can turn a hold line into something the barge-in
   * gate or history will see.
   *
   * **A parameter defaulting to `false` would look equivalent and would not
   * be.** The literal IS the guarantee — it makes "this line is not the agent
   * speaking" a property of the only code path filler has, rather than of what
   * every caller happens to pass. Making it configurable re-opens the bug
   * "Stop dead-air filler from opening the barge-in gate" closed, in which a
   * caller's "are you still there?" counted as interrupting a reply and the
   * abort discarded 16.6s of completed work. Refuse the proposal here.
   */
  function emitFiller(kind: string, toolName: string, text: string): boolean {
    if (channel === undefined || channel.callerSpeaking()) return false;
    channel.boundary();
    channel.send(text, { record: false });
    channel.boundary();
    // LOGGED for the reason the dead-air cover's line is: these never reach a
    // transcript, so without it a harness trajectory shows a covered gap and an
    // uncovered one identically.
    log.info("Tool message", { sid, kind, tool: toolName, text });
    return true;
  }

  return {
    bind(next) {
      channel = next;
      return () => {
        if (channel === next) channel = undefined;
      };
    },
    beginTurn() {
      verbatim = undefined;
    },
    covering: () => coveringCalls > 0,
    verbatim: () => verbatim,
    begin(messages, toolName, args, signal) {
      if (messages === undefined) return;
      const startMessage = selectToolMessage(messages.start, args, random);
      const ladder = planDelayedLadder(messages.delayed, args, random);
      const covers = startMessage !== undefined || ladder.length > 0;
      if (covers) coveringCalls += 1;
      let rung = 0;
      let done = false;
      const startedAt = Date.now();
      const timer = createRestartableTimer(() => {
        if (done || signal?.aborted === true) return;
        const next = ladder[rung];
        rung += 1;
        if (next !== undefined) emitFiller("delayed", toolName, next.content);
        armLadder();
      });
      function armLadder(): void {
        const next = ladder[rung];
        if (next === undefined || done || signal?.aborted === true) return;
        // From the CALL's start, not from the last rung: a 3000/8000 ladder
        // speaks at 3s and 8s, which is what the author wrote down.
        timer.arm(Math.max(1, startedAt + next.afterMs - Date.now()));
      }
      function dispose(): void {
        if (done) return;
        done = true;
        timer.clear();
        if (covers) coveringCalls -= 1;
      }
      armLadder();
      return {
        async start() {
          if (startMessage === undefined) return;
          if (!emitFiller("start", toolName, startMessage.content)) return;
          if (startMessage.blocking !== true || channel === undefined) return;
          // The bound is the CALL SITE's, never the channel's — see the module
          // doc's rule 2. `fallback` rather than a rejection because a start
          // line that outran its budget must cost the call a wait and nothing
          // else, and the `.catch` covers an abort (whose `AbortError` would
          // otherwise surface as this tool having failed).
          await pTimeout(channel.awaitSpoken(startMessage.content, signal), {
            milliseconds: TOOL_START_BLOCKING_MAX_MS,
            ...omitUndefined({ signal }),
            fallback: () => undefined,
          }).catch(() => undefined);
        },
        settled(result) {
          dispose();
          const failed = isFailureResult(result);
          const chosen = selectToolMessage(
            failed ? messages.failed : messages.complete,
            args,
            random,
          );
          if (chosen === undefined) return result;
          if (chosen.role === "system") {
            log.info("Tool message", { sid, kind: "hint", tool: toolName, failed });
            return `${result}\n\n${TOOL_SYSTEM_HINT_LABEL} ${chosen.content}`;
          }
          // An `assistant` completion IS the reply, so it is the one thing here
          // that is recorded and that counts as the agent speaking. Refused
          // once the turn is aborted (the caller took the floor) and once
          // another call in the same step has already claimed the turn — two
          // parallel tools both answering verbatim would talk over each other.
          if (channel === undefined || signal?.aborted === true || verbatim !== undefined) {
            return result;
          }
          verbatim = chosen.content;
          channel.boundary();
          channel.record(chosen.content);
          channel.send(chosen.content, { record: true });
          channel.boundary();
          log.info("Tool message", {
            sid,
            kind: "verbatim",
            tool: toolName,
            failed,
            text: chosen.content,
          });
          return result;
        },
        dispose,
      };
    },
  };
}

/**
 * The default {@link ToolSpeechChannel.awaitSpoken} — the estimate, and the
 * whole implementation. Exported so the transport can hand it over explicitly
 * rather than inheriting a default nobody can see.
 */
export function awaitSpokenEstimate(text: string, signal?: AbortSignal): Promise<void> {
  return sleep(estimateSpokenMs(text), signal === undefined ? {} : { signal });
}
