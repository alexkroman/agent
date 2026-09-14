// Copyright 2026 the AAI authors. MIT license.
/**
 * "May this utterance take the floor?" — the whole of pipeline mode's
 * barge-in decision, in one place and with nothing else in it.
 *
 * It lived inside `pipeline-user-speech.ts`, which also owns the transcript
 * stream, the speaking edges, the nudger and the recovery latch. Splitting it
 * out is not only file length: the decision has FOUR inputs that arrive from
 * three different layers — a word count and a stopwatch the agent set, two
 * phrase lists the agent set, and `bargeIn: "off"` which a dialog STATE sets
 * mid-call — and their precedence is the part of this transport most likely
 * to be got wrong by someone editing one of the four.
 *
 * ## The precedence, top down
 *
 * 1. **Is there a floor to take?** `agentIsSpeaking()` — audio has actually
 *    reached the caller. A turn that has not spoken cannot be spoken over, and
 *    aborting one discards a reply mid-computation to restart a slower one;
 *    `createUserActivity` carries that argument and the starvation case.
 * 2. **`bargeIn: "off"` refuses everything.** An unreachable threshold
 *    (`Infinity`) is a dialog state declaring that this sentence gets
 *    finished — a disclosure, a legal line — stated locally, about this phase,
 *    by the author. The phrase lists below override a THRESHOLD; they must not
 *    override a declaration that there is no threshold.
 * 3. **The two thresholds.** `minBargeInWords`, and then — for an interim
 *    only — `interruptionMinDurationMs`.
 *
 * A committed FINAL skips step 3's second half, as it always has: a final is
 * demonstrably real speech, so there is nothing for a sustained-speech gate to
 * establish.
 *
 * **Empty lists make this byte-identical to the pre-phrase behaviour**, which
 */

import { hasMinWords } from "./pipeline-text.ts";

/**
 * Does the agent HAVE the floor — audio already emitted for the in-flight
 * turn, or forwarded audio still playing out client-side?
 *
 * Built ONCE and read by both the outward speaking-edge gate and the barge-in
 * rules above, because the two must agree by construction: a gate that holds
 * `speech_started` back on one definition while a barge-in fires on another is
 * a client told the agent yielded by a transport that decided it had not.
 *
 * Three things it deliberately is NOT:
 *
 * - **Not "a turn is in flight".** A turn that has yet to emit audio cannot be
 *   spoken over, so a barge-in has nothing to stop; all it would do is discard
 *   the reply mid-computation and restart a strictly slower one (the abandoned
 *   work redone on top of a longer history). A caller re-prompting into that
 *   silence on any regular cadence would starve the reply indefinitely, every
 *   restart outliving the next re-prompt. Utterances arriving before the agent
 *   speaks take the deferral path instead: they commit as chained turns and are
 *   answered once the reply in progress lands.
 * - **Not reset by a mid-reply TTS stall.** Once a turn has spoken it keeps
 *   the floor for the rest of its run, so playback draining while more text is
 *   still streaming does not silently reopen the pre-audio window.
 * - **Not satisfied by FILLER.** The `hasSpokenRecordable` term is what makes
 *   that true: without it a caller talking over a holding phrase counted as
 *   interrupting a reply, and the abort destroyed the reply being generated
 *   behind it. `HeardTracker.spokeRecordable` carries the measurement.
 */
export function createAgentSpeakingPredicate(deps: {
  isPlaybackPending(): boolean;
  isTurnInFlight(): boolean;
  hasTurnSpoken(): boolean;
  hasSpokenRecordable(): boolean;
}): () => boolean {
  return () =>
    (deps.isPlaybackPending() || (deps.isTurnInFlight() && deps.hasTurnSpoken())) &&
    deps.hasSpokenRecordable();
}

export interface BargeInPolicy {
  /**
   * Should this INTERIM transcript interrupt? `words` is the caller's
   * already-counted word total (the scan is bounded, so it is not recomputed
   * here). It takes no TEXT: nothing left in this policy reads the caller's
   * wording.
   */
  partialInterrupts(words: number): boolean;
  /** Should this committed FINAL replace the in-flight reply? */
  finalInterrupts(text: string): boolean;
}

export function createBargeInPolicy(deps: {
  /** Audio has reached the caller — see the module doc, step 1. */
  agentIsSpeaking: () => boolean;
  /** Interim words required to interrupt; `Infinity` is `bargeIn: "off"`. Per dialog state. */
  minBargeInWords: () => number;
  /** Sustained-speech gate for an interim-triggered barge-in; 0 disables. Per state. */
  interruptionMinDurationMs: () => number;
  /** Ms since this utterance's first partial, or 0 when no edge is open. */
  utteranceDurationMs: () => number;
}): BargeInPolicy {
  return {
    partialInterrupts(words: number): boolean {
      if (!deps.agentIsSpeaking()) return false;
      if (words < deps.minBargeInWords()) return false;
      const gate = deps.interruptionMinDurationMs();
      return !(gate > 0 && deps.utteranceDurationMs() < gate);
    },

    finalInterrupts(text: string): boolean {
      if (!deps.agentIsSpeaking()) return false;
      return hasMinWords(text, deps.minBargeInWords());
    },
  };
}
