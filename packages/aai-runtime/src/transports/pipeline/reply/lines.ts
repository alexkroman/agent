// Copyright 2026 the AAI authors. MIT license.
/**
 * CODE-INITIATED lines — every word pipeline mode speaks that no model token
 * produced — and the one place their two rules are decided: what the CAPTION
 * says, and what HISTORY records (what was heard, and only when it is on the
 * record). Every such line states the same two flags a `speech.say()` takes,
 * {@link LineFlags}, and goes through one of two placements:
 *
 * | line | placement | `record` | `interruptible` | caption |
 * | --- | --- | --- | --- | --- |
 * | greeting, `speech.say()` | a reply of its own ({@link createLineReply}) | `true` (`say`: the author's) | `true` (`say`: the author's) | one final |
 * | error / start-failure phrase | the failed turn's last words ({@link speakFixedLine}) | never (`recovery` tag) | `true` | one final |
 * | dead-air filler | inside the reply in flight ({@link speakInReply}) | `false` | `true` | the reply's interim |
 * | tool START / DELAYED line | inside the reply in flight | `false` | `true` | the reply's interim |
 * | tool `assistant` completion | inside the reply in flight | `true` | `true` | the reply's interim, then its final |
 *
 * The silence nudge and a run's `notify` are NOT code-initiated LINES: each is
 * a MODEL turn on an injected instruction (`runChainedTurn(…, { synthetic:
 * true })`, the one path `Transport.injectTurn` and the nudger share), so the
 * model's reply follows the ordinary turn rules and owes nothing here.
 *
 * ## Why the in-reply placement is one function
 *
 * Filler and a tool's messages used to spell their own sends — boundary, send,
 * boundary, plus an `onDelta` for a verbatim completion — and had drifted on the
 * caption rule: only the dead-air cover went through the stream-part handler's
 * segment separator, so a tool's line FUSED with the words around it ("Let me
 * check.One moment."), in the caption and, for a verbatim completion, in the
 * turn's recorded text. {@link speakInReply} is the one spelling.
 *
 * Inside a reply, `record` is ALSO the barge-in eligibility of the words
 * (`HeardTracker.spokeRecordable()`): a line that is not the agent's own
 * dialogue must not let a caller's "are you still there?" count as cutting the
 * work it covers ("Stop dead-air filler from opening the barge-in gate"). The
 * reply it sits in is what a barge-in cuts, so an in-reply line is exactly as
 * interruptible as that reply — `interruptible: true` by type.
 *
 * ## FIXED lines, and why they drifted
 *
 * The greeting, the error phrase and the start-failure phrase each used to
 * spell their own sends, and had drifted on the same two rules:
 *
 * | line | caption, before | caption, now | history, before | history, now |
 * | --- | --- | --- | --- | --- |
 * | greeting | final | final | whole line, up front | whole line once it has PLAYED OUT, the heard prefix `[interrupted]` if it was cut — during synthesis or playback |
 * | error phrase | interim + a byte-identical final | final | never | never |
 * | start failure | final | final | never | never |
 *
 * The error phrase's interim was the duplicate-caption bug the greeting's own
 * spec already names ("publishes the greeting transcript exactly once"), fixed
 * for one line of three. And the greeting was the one reply in this transport
 * that ignored "history records what was HEARD": a caller who cut it off after
 * two words left a history saying the agent had delivered all of it.
 *
 * ## What is decided HERE, and what is left to the caller
 *
 * {@link speakFixedLine} decides the caption, the barge-in gate and whether the
 * line is on the record; {@link createLineReply} adds the one thing a line
 * spoken as a reply of its own owes, the history write once its outcome is
 * known. WHERE a line runs stays with its caller, because those really do
 * differ — the greeting is a queued reply, the error phrase is the last words
 * of a failed turn's reply, the start-failure phrase runs outside any reply
 * before the teardown — and `../turn-outcome.ts` argues why merging THAT
 * would erase the point.
 *
 * Every fixed line opens the barge-in gate (`record: true` on the heard
 * cursor): each is the agent speaking, and a caller may cut it off. What keeps
 * a failure phrase out of the RECORD is the `recovery` tag on its caption, the
 * one thing on the wire every history reader keys on — see "The `never` in that
 * row is on the WIRE" in `../turn-outcome.ts`.
 *
 * @module
 */

import type { SessionEventBody } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { LineFlags, SendTtsText, TransportCallbacks } from "../../types.ts";
import type { HeardTracker } from "../heard/index.ts";
import { type PipelineHistory, persistInterruptedTurn } from "../history/index.ts";
import type { TurnGate, TurnMachine } from "../turn/index.ts";

/** A line spoken INSIDE a reply: as interruptible as the reply it sits in. @internal */
export type InReplyLineFlags = LineFlags & { readonly interruptible: true };

/**
 * The reply in flight's text funnel, as {@link speakInReply} uses it — the
 * stream-part handler's, which owns the segment separator and the transcript.
 *
 * @internal
 */
export type ReplyTextSink = {
  /** Emit text into the reply: separator, transcript when `record`, TTS. */
  emit(text: string, record: boolean): void;
  /** Release what the TTS coalescer holds, and re-arm its first chunk. */
  boundary(): void;
  /** The next text is a new segment: separate it from this line. */
  separate(): void;
};

/**
 * Speak one code-initiated line INSIDE the reply in flight — the dead-air
 * cover's filler and a tool's declared messages; see this module's table.
 *
 * Bounded by a TTS boundary on both sides: before, because a tool call is not
 * guaranteed to follow the `text-end` that releases the buffer (the AI SDK may
 * start `execute` first) and a line sent past a buffered fragment would be
 * spoken out of order; after, because the reply has gone quiet and nothing
 * else is coming to flush it. Separated from what follows, so the next segment
 * does not fuse onto it.
 *
 * @internal
 */
export function speakInReply(sink: ReplyTextSink, text: string, line: InReplyLineFlags): void {
  if (text.length === 0) return;
  sink.boundary();
  sink.separate();
  sink.emit(text, line.record);
  sink.separate();
  sink.boundary();
}

/** The tag a failure phrase's caption carries — `AgentTranscriptRecovery`. */
type Recovery = NonNullable<SessionEventBody<"agentTranscript.committed">["recovery"]>;

/**
 * One fixed line. The union is the rule: a line is either on the RECORD or a
 * recovery phrase, never both — a recovery phrase in history teaches the model
 * its replies open with apologies.
 *
 * @internal
 */
export type FixedLine =
  | { readonly text: string; readonly recovery?: undefined; readonly recorded?: false }
  | { readonly text: string; readonly recovery: Recovery; readonly recorded?: undefined };

/**
 * Caption and speak one fixed line.
 *
 * The caption is a FINAL published BEFORE the text reaches TTS, with the
 * interim suppressed: the whole line goes to TTS in one send, so an interim
 * would be a byte-identical copy of the final, published in the wrong order.
 *
 * @internal
 */
export function speakFixedLine(
  deps: { sendTtsText: SendTtsText; callbacks: Pick<TransportCallbacks, "report"> },
  line: FixedLine,
): void {
  deps.callbacks.report({
    type: "agentTranscript.committed",
    text: line.text,
    ...omitUndefined({ recovery: line.recovery, recorded: line.recorded }),
  });
  deps.sendTtsText(line.text, { publishTranscript: false });
}

/** Sleep until the heard clock says playback is over, or the reply is cut. */
async function awaitPlayout(heard: HeardTracker, signal: AbortSignal): Promise<void> {
  for (let wait = heard.playoutMs(); wait > 0 && !signal.aborted; wait = heard.playoutMs()) {
    await sleep(wait, { signal });
  }
}

/** What {@link createLineReply} needs from the transport. @internal */
export interface LineReplyDeps {
  sendTtsText: SendTtsText;
  callbacks: Pick<TransportCallbacks, "report">;
  history: PipelineHistory;
  heard: HeardTracker;
  gate: TurnGate;
  turns: TurnMachine;
  /** The per-reply TTS drain. */
  drainTts: (signal: AbortSignal) => Promise<void>;
  /** The transport's reply scaffold. */
  runReply: (idPrefix: string, body: (signal: AbortSignal) => Promise<boolean>) => Promise<void>;
}

/**
 * How a {@link createLineReply} line ended: played out to the end, or cut off
 * (a barge-in, a cancel, a reset, the session ending) after it started.
 *
 * @internal
 */
export type LineOutcome = "played" | "interrupted";

/**
 * Speak a recorded fixed line as a reply of its own — the greeting, and every
 * `say` — and write it to history once its outcome is known.
 *
 * The body drains TTS ITSELF rather than returning `true` for `runReply` to
 * drain, because the history write has to follow the drain inside the reply:
 * after `runReply` returns, `reply.completed` has already gone out and a reader
 * acting on it would find history without the line. The draining flag is set
 * around the drain exactly as `runReply` sets it, so a barge-in in that window
 * is classified the same way.
 *
 * **It then waits out PLAYBACK, not just synthesis.** The drain resolves when
 * the provider has finished synthesizing, which is faster than real time: a
 * four-second greeting is synthesized a second in, with three seconds still in
 * the client's buffer — and that window is where a caller usually cuts in.
 * Recording at the drain would write the whole line there and nothing would
 * trim it. Keeping the reply in flight until the heard clock says playback is
 * over means a barge-in in that window cuts THIS reply, and the heard prefix
 * is what gets recorded. The wait reads the clock and signals nothing; a
 * client playback report can only extend it, so it is re-read after each
 * sleep.
 *
 * It resolves with the {@link LineOutcome}, read off the reply's own signal:
 * that is what a `say`'s `done` reports, and "played" means the heard clock ran
 * out, not that synthesis did. `onStart` fires as the line takes the floor.
 *
 * `record: false` (a `say`'s) keeps the line out of BOTH histories, played or
 * cut, and tags its caption `recorded: false` so the session's own history and
 * a resume skip it too: the caption is the one record every reader keys on.
 *
 * @internal
 */
export function createLineReply(deps: LineReplyDeps) {
  const { history, heard, gate, turns } = deps;
  return async (
    idPrefix: string,
    text: string,
    line: { onStart?: () => void; record?: boolean } = {},
  ): Promise<LineOutcome> => {
    const record = line.record !== false;
    let outcome: LineOutcome = "interrupted";
    await deps.runReply(idPrefix, async (signal) => {
      line.onStart?.();
      const historyEpoch = gate.historyEpoch();
      speakFixedLine(deps, record ? { text } : { text, recorded: false });
      turns.setDraining(true);
      try {
        await deps.drainTts(signal);
        await awaitPlayout(heard, signal);
      } finally {
        turns.setDraining(false);
      }
      if (!signal.aborted) outcome = "played";
      if (!(record && gate.historyCurrent(historyEpoch))) return false;
      if (signal.aborted) {
        // The same rule, and the same helper, a model reply cut by a barge-in
        // goes through — so "heard" means one thing in this transport.
        persistInterruptedTurn({
          history,
          heard: heard.heard().text,
          persistedLen: 0,
          stepMessages: [],
        });
        return false;
      }
      history.pushConversation({ role: "assistant", content: text });
      history.pushLlm({ role: "assistant", content: text });
      return false;
    });
    return outcome;
  };
}
