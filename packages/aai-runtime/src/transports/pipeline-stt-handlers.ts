// Copyright 2026 the AAI authors. MIT license.
/**
 * The STT transcript-stream handlers: what an interim and a committed
 * transcript each DO.
 *
 * Split from `pipeline-user-speech.ts`, which is the other half of the same
 * subject and now holds only the WIRING — the nudger, the recovery latch, the
 * speaking edges, the low-confidence gate and the predicates all of those are
 * built from. The seam is the one that file's own doc already described, and
 * the two halves read differently: this one is threshold and ordering rules
 * (when does a partial barge in, when is a final not a turn), and that one is
 * construction.
 */

import type { SttTurnMeta } from "@alexkroman1/aai/host-internal";
import { DEFAULT_FALSE_INTERRUPTION_PROMPT } from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { debugPartialsEnabled, type Logger } from "../runtime-config.ts";
import type { LowConfidenceGate } from "./pipeline-low-confidence.ts";
import type { FalseInterruptionRecovery } from "./pipeline-recovery.ts";
import type { SilenceNudger } from "./pipeline-silence.ts";
import type { SpeculationController } from "./pipeline-speculation.ts";
import type { GatedSpeechEdges, SpeechEdgeTracker } from "./pipeline-speech-edges.ts";
import { hasMinWords, scanWords } from "./pipeline-text.ts";
import type { TransportCallbacks } from "./types.ts";

/**
 * One line per interim is the noisiest thing in a voice session — one per
 * ~200ms of speech, each a revision of the last — so it is opt-in via
 * `AAI_DEBUG_PARTIALS=1` rather than plain `AAI_DEBUG`. Hoisted out of
 * `onSttPartial` to keep that handler under the complexity cap; the branch is
 * real logic, not noise to suppress.
 *
 * This gate deliberately does NOT cover the provider's own turn trace, which
 * carries the same text plus `end_of_turn` and the end-of-turn confidence —
 * that is the raw material for measuring an endpointing policy, and silencing
 * the redundant copy must not lose it.
 */
function tracePartial(log: Logger, sid: string, text: string, meta?: SttTurnMeta): void {
  if (!debugPartialsEnabled) return;
  log.debug("Pipeline STT partial", { sid, text, eot: meta?.endOfTurnConfidence });
}

/**
 * The part of {@link SpeculationController} the speech handlers drive. Narrowed
 * by subtraction so this module cannot reach `take`/`discard`, which belong to
 * turn orchestration.
 */
export type SpeculationHooks = Pick<
  SpeculationController,
  "onPartial" | "onFinal" | "onUtteranceIdle"
>;

/** STT transcript-stream handlers. See {@link createSttEventHandlers}. */
export interface SttEventHandlers {
  /** An interim transcript arrived. */
  onSttPartial(text: string, meta?: SttTurnMeta): void;
  /** A committed transcript arrived. */
  onSttFinal(text: string, meta?: SttTurnMeta): void;
}

/**
 * Turn the STT transcript stream into speaking edges, live captions, barge-in
 * decisions and committed turns.
 *
 * Split out of the transport so the barge-in policy — which is all threshold
 * and ordering rules rather than turn orchestration — reads on its own. The
 * transport's mutable turn state arrives as the `isTurnInFlight` /
 * `hasTurnSpoken` / `agentIsSpeaking` predicates rather than as captured
 * variables, so this module never needs to know how a turn is represented.
 */
export function createSttEventHandlers(deps: {
  /** True once the transport terminated — every inbound event is then dropped. */
  isTerminated: () => boolean;
  /** True while a turn is in flight server-side (an abortable reply exists). */
  isTurnInFlight: () => boolean;
  /**
   * True while the in-flight turn's body has completed (full text persisted,
   * no [interrupted] marker) and only its TTS drain remains.
   */
  isTurnDraining: () => boolean;
  /** True while the in-flight turn is a false-interruption resume. */
  isResumeTurnInFlight: () => boolean;
  /** True once the in-flight turn has put audio on the wire. */
  hasTurnSpoken: () => boolean;
  /**
   * Is the agent actually speaking right now — audio already emitted for the
   * in-flight turn, or forwarded audio still playing out client-side? Passed in
   * rather than derived here, the way `edgeGate` is: it is the predicate the
   * whole barge-in policy turns on, and the outward speaking-edge gate turns on
   * the same one. See {@link createUserActivity} for the definition and why it
   * is not "a turn is in flight".
   */
  agentIsSpeaking: () => boolean;
  /** Has this reply sent real speech, as opposed to dead-air filler? */
  hasSpokenRecordable: () => boolean;
  /** Abort the in-flight turn and cancel TTS playback. */
  abortInFlightTurn: () => void;
  /**
   * Resume prompt for a barge-in on the client playback tail — the reply
   * finished server-side but its audio was still playing out. `undefined` when
   * the caller had essentially heard it all (then a cut costs nothing worth a
   * resume turn). Ordering-independent: the abort LATCHES the cut position
   * before resetting the playback clock (see `HeardTracker.cut`), so this
   * reads the same answer either side of it.
   */
  tailResumePrompt: () => string | undefined;
  speechEdges: SpeechEdgeTracker;
  /** Outward speaking-edge gate — see {@link createGatedSpeechEdges}. */
  edgeGate: GatedSpeechEdges;
  recovery: FalseInterruptionRecovery;
  nudger: SilenceNudger;
  callbacks: Pick<TransportCallbacks, "report">;
  /**
   * Commit a user turn: emit the transcript and run the chained reply. `note`
   * rides on the MODEL's copy only — see {@link createUserActivity}.
   */
  commitUserTurn: (text: string, note?: string) => void;
  /** `AgentDef.lowConfidence`, bound to this session; absent when unset. */
  lowConfidence: LowConfidenceGate | undefined;
  /** Preemptive generation, or a no-op controller when the flag is off. */
  speculation: SpeculationHooks;
  /**
   * Interim words required to barge in — a THUNK, resolved at the moment a
   * partial is classified.
   *
   * It was a number, captured for the length of the call, until a `dialog()`
   * state could declare its own `bargeIn`: a disclosure state has to be able to
   * FINISH its sentence and a menu state wants to be maximally interruptible, so
   * the threshold belongs to the phase rather than to the session. `Infinity`
   * is `bargeIn: "off"` and is what those two gates read as "never" — see
   * `pipeline-dialog-knobs.ts`.
   */
  minBargeInWords: () => number;
  /** Sustained-speech gate for interim-triggered barge-in; 0 disables. Per state too. */
  interruptionMinDurationMs: () => number;
  log: Logger;
  sid: string;
}): SttEventHandlers {
  const { speechEdges, recovery, nudger, callbacks, log, agentIsSpeaking } = deps;

  /**
   * Arm false-interruption recovery for the partial-triggered barge-in that is
   * about to fire, with the resume prompt that fits the shape of the cut.
   *
   * Runs before `abortInFlightTurn`, but no longer HAS to: the abort latches
   * the cut position before resetting the playback clock it is read from (see
   * `HeardTracker.cut`), and the latch starts no timer of its own.
   *
   * "In flight" alone is the wrong classifier: the turn controller stays
   * non-null through the TTS drain, which for a sentence-flushing adapter lasts
   * as long as the remaining synthesis. A turn in that window already persisted
   * its FULL text with no `[interrupted]` marker, so the mid-turn prompt would
   * tell the model to continue past an ending it produced — it repeats itself
   * or rambles. Only a turn whose body is still streaming can resume from the
   * marker; everything else is a playback cut. Either way the CUT-POINT prompt
   * wins when one is available (see `buildTailResumePrompt` in
   * pipeline-recovery.ts for the repetition measurement behind that), and a
   * fully-heard tail arms nothing: there is nothing left to resume.
   */
  function armBargeInRecovery(): void {
    const cutPrompt = deps.tailResumePrompt();
    if (deps.isTurnInFlight() && !deps.isTurnDraining()) {
      recovery.arm(cutPrompt ?? DEFAULT_FALSE_INTERRUPTION_PROMPT);
      return;
    }
    if (cutPrompt !== undefined) recovery.arm(cutPrompt);
  }

  /** Should this interim transcript interrupt the agent right now? */
  function partialTriggersBargeIn(words: number): boolean {
    if (!agentIsSpeaking()) return false;
    if (words < deps.minBargeInWords()) return false;
    // Duration gate (interim-only): require sustained speech since the
    // utterance's first partial before cutting the agent off. A committed
    // final barging in via onSttFinal is never duration-gated.
    const gate = deps.interruptionMinDurationMs();
    return !(gate > 0 && speechEdges.durationMs() < gate);
  }

  return {
    onSttPartial(text: string, meta?: SttTurnMeta): void {
      if (deps.isTerminated()) return;
      // Debug trace (AAI_DEBUG=1): partials are the only record of a word STT
      // heard mid-utterance and then dropped from its final, which otherwise
      // looks like the LLM inventing a tool argument out of nowhere.
      tracePartial(log, deps.sid, text, meta);
      // User speech proves presence: reset the nudge budget, restart the window.
      nudger.onUserSpeech();
      // Counted once, with a bounded scan: every consumer here is a threshold
      // check — the speaking edge and caption emit need >= 1, the barge-in
      // gate needs >= minBargeInWords — so the scan stops at
      // max(minBargeInWords, 1) instead of walking the whole partial,
      // which grows to full-utterance length as the user keeps speaking.
      const words = scanWords(text, Math.max(deps.minBargeInWords(), 1));
      // Live captions: forward the interim transcript as-is. The committed turn
      // still arrives via onUserTranscript once the STT final lands. Emitted
      // after any barge-in below, because the client's `cancelled` handler
      // clears userTranscript — emitting first would blank the caption it just
      // set.
      const emitPartial = (): void => {
        if (words >= 1) {
          callbacks.report({
            type: "user-transcript.updated",
            text,
            ...omitUndefined({ eotConfidence: meta?.endOfTurnConfidence }),
          });
        }
      };
      // Opens the speaking edge and restarts its idle watchdog — which is also
      // what holds an armed resume back while the user keeps talking, since the
      // watchdog is the only thing that releases one.
      if (words >= 1) speechEdges.speechStarted();
      if (!partialTriggersBargeIn(words)) {
        // The agent may have finished its reply while this utterance ran; a
        // held edge then has no floor left to protect and is released here
        // rather than on a timer. Cheap, and partials keep arriving for as
        // long as the user is talking.
        if (!agentIsSpeaking()) deps.edgeGate.release();
        emitPartial();
        // Preemptive generation (on by default) reads the confidence here and
        // nowhere else — the non-barge-in branch IS the idle-ish case it is
        // allowed to fire in, and one call site keeps this handler under the
        // cognitive-complexity cap it already sits near.
        deps.speculation.onPartial(text, meta?.endOfTurnConfidence);
        return;
      }
      log.info("Pipeline barge-in", { sid: deps.sid });
      armBargeInRecovery();
      deps.abortInFlightTurn();
      // Ordered before `cancelled`: this is the moment the agent yields, which
      // is what `speech_started` promises the client in S2S mode too.
      deps.edgeGate.release();
      callbacks.report({ type: "reply.cancelled" });
      emitPartial();
    },

    onSttFinal(text: string, meta?: SttTurnMeta): void {
      if (deps.isTerminated()) return;
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      // The recognizer's own verdict on the WORDS, before the model sees them.
      // FIRST, because everything below this line treats the transcript as
      // something the caller meant to say — and the two failing verdicts are
      // precisely the claim that it is not. A note falls through: that turn
      // runs normally and only the model's copy is annotated.
      const verdict = deps.lowConfidence?.classify(trimmed, meta);
      if (verdict === "handled") return;
      // Debug trace (AAI_DEBUG=1): pairs with "Pipeline turn committed" below.
      // Finals that differ from the commit locate a loss in aggregation; a
      // commit that matches the finals locates it in STT instead.
      log.debug("Pipeline STT final", { sid: deps.sid, text: trimmed });
      // Before anything else this handler does: a speculation this final cannot
      // match is billed for as long as it runs, so it is aborted at the
      // earliest possible instant rather than when the turn chain drains.
      deps.speculation.onFinal(trimmed);
      // Real speech reached a final — whatever barge-in preceded it was not a
      // false interruption; a genuine turn commits below. Restores the
      // consecutive-resume budget too: the user is demonstrably present.
      recovery.onUserTurn();
      // The resume may have already fired: the speaking edge went idle before
      // this final landed, which happens whenever the STT's endpointing plus
      // final-emission latency exceeds `speechIdleTimeoutMs` — the transport
      // cannot see that window, so this is the backstop for it. A resume turn
      // is then in flight covering an "interruption" this final just proved
      // genuine. Abort it while it is still silent — otherwise the
      // agent first speaks a full continuation of the interrupted reply and
      // only then answers the user. A resume that already spoke falls through
      // to the ordinary barge-in rules below. This cannot starve replies the
      // way aborting unspoken turns generally would: only resume turns are
      // aborted here, and each abort is caused by a committed user turn.
      if (deps.isResumeTurnInFlight() && !deps.hasTurnSpoken()) {
        log.info("Pipeline resume mooted by committed user turn", { sid: deps.sid });
        deps.abortInFlightTurn();
        callbacks.report({ type: "reply.cancelled" });
      }
      // A final can arrive without any preceding partial (short utterances on
      // some STT providers) — make sure the speaking edge still fires.
      speechEdges.speechStarted();
      // The turn that follows re-arms the nudge on completion.
      nudger.onUserTurn();
      // Interrupt the agent's reply only when it is actually speaking and the
      // utterance is clearly intentional (>= threshold). Anything else does NOT
      // interrupt — the turn is answered once the reply finishes (chainTurn
      // defers it), so neither short answers ("yes", a ZIP) spoken over the
      // agent nor re-prompts into a not-yet-spoken reply are lost.
      if (agentIsSpeaking() && hasMinWords(trimmed, deps.minBargeInWords())) {
        log.info("Pipeline replacing in-flight turn", { sid: deps.sid });
        deps.abortInFlightTurn();
        deps.edgeGate.release();
        callbacks.report({ type: "reply.cancelled" });
      }
      // Commit the turn immediately: endpointing (aggregating a disfluent
      // utterance's pauses into one final) is the STT provider's job — the
      // AssemblyAI opener sets `min_turn_silence` for exactly this.
      speechEdges.speechEnded();
      deps.commitUserTurn(trimmed, verdict?.note);
    },
  };
}
