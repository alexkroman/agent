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
 * 3. **What did they SAY?** The two phrase lists (`sdk/barge-in-phrases.ts`):
 *    an acknowledgement never interrupts, an interruption phrase always does.
 *    Above both gates on purpose — each gate is a PROXY for "did the caller
 *    mean to take the floor", and when the words answer that directly the
 *    proxy has nothing to add.
 * 4. **The two thresholds.** `minBargeInWords`, and then — for an interim
 *    only — `interruptionMinDurationMs`.
 *
 * A committed FINAL skips step 4's second half, as it always has: a final is
 * demonstrably real speech, so there is nothing for a sustained-speech gate to
 * establish.
 *
 * **Empty lists make this byte-identical to the pre-phrase behaviour**, which
 * is what `"none"` at step 3 buys: the decision falls straight through to the
 * thresholds.
 */

import { type BargeInPhraseVerdict, classifyBargeInPhrase } from "@alexkroman1/aai/internal";
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

/** The two lists, as one session's policy. */
export interface BargeInPhraseLists {
  acknowledgement: readonly string[];
  interruption: readonly string[];
}

export interface BargeInPolicy {
  /**
   * Should this INTERIM transcript interrupt? `words` is the caller's
   * already-counted word total (the scan is bounded, so it is not recomputed
   * here).
   */
  partialInterrupts(words: number, text: string): boolean;
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
  /** The two phrase lists. Agent-scoped: a dialog moves the threshold, not these. */
  phrases: BargeInPhraseLists;
}): BargeInPolicy {
  /**
   * What the phrase lists say about this utterance, with step 2 applied
   * first — see the module doc for why `bargeIn: "off"` silences the lists.
   */
  function verdict(text: string): BargeInPhraseVerdict {
    if (!Number.isFinite(deps.minBargeInWords())) return "none";
    return classifyBargeInPhrase(text, deps.phrases);
  }

  return {
    partialInterrupts(words: number, text: string): boolean {
      if (!deps.agentIsSpeaking()) return false;
      const said = verdict(text);
      if (said === "acknowledge") return false;
      if (said === "interrupt") return true;
      if (words < deps.minBargeInWords()) return false;
      const gate = deps.interruptionMinDurationMs();
      return !(gate > 0 && deps.utteranceDurationMs() < gate);
    },

    finalInterrupts(text: string): boolean {
      if (!deps.agentIsSpeaking()) return false;
      const said = verdict(text);
      if (said === "acknowledge") return false;
      if (said === "interrupt") return true;
      return hasMinWords(text, deps.minBargeInWords());
    },
  };
}
