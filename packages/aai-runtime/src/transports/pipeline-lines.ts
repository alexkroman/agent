// Copyright 2026 the AAI authors. MIT license.
/**
 * FIXED lines — the words pipeline mode speaks that no model turn produced: the
 * greeting, the error phrase after a failed turn, and the start-failure phrase.
 *
 * Each used to spell its own sends, and the three spellings had drifted on the
 * two rules every one of them has to get right:
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
 * before the teardown — and `pipeline-turn-outcome.ts` argues why merging THAT
 * would erase the point.
 *
 * Every fixed line opens the barge-in gate (`record: true` on the heard
 * cursor): each is the agent speaking, and a caller may cut it off. What keeps
 * a failure phrase out of the RECORD is the `recovery` tag on its caption, the
 * one thing on the wire every history reader keys on — see "The `never` in that
 * row is on the WIRE" in `pipeline-turn-outcome.ts`.
 *
 * @module
 */

import { sleep } from "@alexkroman1/aai/internal";
import type { SessionEventBody } from "@alexkroman1/aai/protocol";
import type { HeardTracker } from "./pipeline-heard.ts";
import { type PipelineHistory, persistInterruptedTurn } from "./pipeline-history.ts";
import type { TurnGate } from "./pipeline-turn-gate.ts";
import type { TurnMachine } from "./pipeline-turn-state.ts";
import type { SendTtsText, TransportCallbacks } from "./types.ts";

/** The tag a failure phrase's caption carries — `AgentTranscriptRecovery`. */
type Recovery = NonNullable<
  Extract<SessionEventBody, { type: "agent-transcript.committed" }>["recovery"]
>;

/**
 * One fixed line. The union is the rule: a line is either on the RECORD or a
 * recovery phrase, never both — a recovery phrase in history teaches the model
 * its replies open with apologies.
 *
 * @internal
 */
export type FixedLine =
  | { readonly text: string; readonly recovery?: undefined }
  | { readonly text: string; readonly recovery: Recovery };

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
    type: "agent-transcript.committed",
    text: line.text,
    ...(line.recovery === undefined ? {} : { recovery: line.recovery }),
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
 * Speak a recorded fixed line as a reply of its own — the greeting — and write
 * it to history once its outcome is known.
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
 * @internal
 */
export function createLineReply(deps: LineReplyDeps) {
  const { history, heard, gate, turns } = deps;
  return (idPrefix: string, text: string): Promise<void> =>
    deps.runReply(idPrefix, async (signal) => {
      const historyEpoch = gate.historyEpoch();
      speakFixedLine(deps, { text });
      turns.setDraining(true);
      try {
        await deps.drainTts(signal);
        await awaitPlayout(heard, signal);
      } finally {
        turns.setDraining(false);
      }
      if (!gate.historyCurrent(historyEpoch)) return false;
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
}
