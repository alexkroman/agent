// Copyright 2026 the AAI authors. MIT license.
/**
 * The STT transcript-stream handlers: what an interim and a committed
 * transcript each DO.
 *
 * Split from `pipeline-user-speech.ts`, which is the other half of the same
 * subject and now holds only the WIRING — the nudger, the recovery latch, the
 * speaking edges and the predicates all of those are
 * built from. The seam is the one that file's own doc already described, and
 * the two halves read differently: this one is threshold and ordering rules
 * (when does a partial barge in, when is a final not a turn), and that one is
 * construction.
 */

import { DEFAULT_FALSE_INTERRUPTION_PROMPT } from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { SttTurnMeta } from "../providers/openers.ts";
import { debugPartialsEnabled, type Logger } from "../runtime-config.ts";
import { createBargeInPolicy } from "./pipeline-barge-in-policy.ts";
import type { ManualTurn } from "./pipeline-manual-turn.ts";
import type { FalseInterruptionRecovery } from "./pipeline-recovery.ts";
import type { SilenceNudger } from "./pipeline-silence.ts";
import type { SpeculationController } from "./pipeline-speculation.ts";
import type { GatedSpeechEdges, SpeechEdgeTracker } from "./pipeline-speech-edges.ts";
import { scanWords } from "./pipeline-text.ts";
import type { UserTurnLimiter } from "./pipeline-user-turn-limit.ts";
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
   * Does the agent have the floor? Passed in rather than derived here, the way
   * `edgeGate` is — both must read the same answer. See
   * `createAgentSpeakingPredicate`.
   */
  agentIsSpeaking: () => boolean;
  /**
   * Is any agent audio on the line, filler included? What the edge gate reads,
   * so it is what decides whether a held edge still has a floor to protect.
   * See `createAudioOnLinePredicate`.
   */
  audioOnLine: () => boolean;
  /**
   * Did the agent have the floor when the current utterance began? Only such
   * an utterance can barge in — see `createBargeInPolicy`, step 1.
   */
  utteranceOpenedOverSpeech: () => boolean;
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
  /** Preemptive generation, or a no-op controller when the flag is off. */
  speculation: SpeculationHooks;
  /**
   * Interim words required to barge in — a THUNK, resolved at the moment a
   * partial is classified, because a `dialog()` state may declare its own
   * `bargeIn`: a disclosure state has to be able to FINISH its sentence and a
   * menu state wants to be maximally interruptible, so the threshold belongs
   * to the phase rather than to the session. `Infinity` is `bargeIn: "off"`.
   */
  minBargeInWords: () => number;
  /** Sustained-speech gate for interim-triggered barge-in; 0 disables. Per state too. */
  interruptionMinDurationMs: () => number;
  /** A real interruption fired: arm the post-interruption audio block. */
  onInterrupted: () => void;
  /**
   * The cap on one user turn, or `NO_USER_TURN_LIMIT`. Fed every partial's
   * text and word count; its deadline is armed and cleared by the speaking
   * edge, not here — see `pipeline-user-turn-limit.ts`.
   */
  turnLimit: UserTurnLimiter;
  /**
   * Push-to-talk, or the inert `AUTO_TURN_DETECTION`. When enabled it owns
   * every final (held until the client commits) and the caption, and no
   * transcript barges in — opening a turn is the barge-in there.
   */
  manualTurn: ManualTurn;
  log: Logger;
  sid: string;
}): SttEventHandlers {
  const { speechEdges, recovery, nudger, callbacks, log, agentIsSpeaking, turnLimit, manualTurn } =
    deps;

  /**
   * An interim under push-to-talk: caption the WHOLE held turn, never barge in,
   * never speculate — no pause is a turn boundary, so a speculation built on
   * one could only be discarded. A partial outside a turn is not shown.
   */
  function onManualPartial(text: string, words: number, meta?: SttTurnMeta): void {
    const caption = manualTurn.onPartial(text);
    if (caption === undefined || words < 1) return;
    callbacks.report({
      type: "user-transcript.updated",
      text: caption,
      ...omitUndefined({ eotConfidence: meta?.endOfTurnConfidence }),
    });
  }

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

  // "May this utterance take the floor?" — the four-input precedence, in a
  // module of its own. See pipeline-barge-in-policy.ts.
  const bargeIn = createBargeInPolicy({
    agentIsSpeaking,
    utteranceOpenedOverSpeech: deps.utteranceOpenedOverSpeech,
    minBargeInWords: deps.minBargeInWords,
    interruptionMinDurationMs: deps.interruptionMinDurationMs,
    utteranceDurationMs: () => speechEdges.durationMs(),
  });

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
      // gate needs >= minBargeInWords, the turn cap needs >= its maxWords —
      // so the scan stops at the largest of those instead of walking the
      // whole partial, which grows to full-utterance length as the user keeps
      // speaking.
      const words = scanWords(text, Math.max(deps.minBargeInWords(), turnLimit.maxWords, 1));
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
      if (words >= 1) {
        speechEdges.speechStarted();
        // AFTER the edge opens, so the first partial of an utterance is counted
        // against a deadline that is already armed rather than one the next
        // partial arms. Fires at most once per utterance — see the latch.
        turnLimit.onPartial(text, words);
      }
      if (manualTurn.enabled) {
        onManualPartial(text, words, meta);
        return;
      }
      if (!bargeIn.partialInterrupts(words)) {
        // The agent may have finished its reply while this utterance ran; a
        // held edge then has no floor left to protect and is released here
        // rather than on a timer. Cheap, and partials keep arriving for as
        // long as the user is talking.
        if (!deps.audioOnLine()) deps.edgeGate.release();
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
      // The caller has the floor: hold agent audio for the backoff window, so
      // the reply that follows does not land on top of the utterance that
      // interrupted this one. Armed before the abort, because the abort is
      // what lets the next turn start.
      deps.onInterrupted();
      deps.abortInFlightTurn();
      // Ordered before `cancelled`: this is the moment the agent yields, which
      // is what `speech_started` promises the client in S2S mode too.
      deps.edgeGate.release();
      callbacks.report({ type: "reply.cancelled" });
      emitPartial();
    },

    onSttFinal(text: string): void {
      if (deps.isTerminated()) return;
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
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
      // Push-to-talk: the final is one piece of a turn the CLIENT ends, so it
      // is held rather than answered — and it cannot barge in, because opening
      // the turn already did.
      if (manualTurn.enabled) {
        speechEdges.speechEnded();
        manualTurn.onFinal(trimmed);
        return;
      }
      // Interrupt the agent's reply only when it is actually speaking and the
      // utterance is clearly intentional (>= threshold). Anything else does NOT
      // interrupt — the turn is answered once the reply finishes (chainTurn
      // defers it), so neither short answers ("yes", a ZIP) spoken over the
      // agent nor re-prompts into a not-yet-spoken reply are lost.
      if (bargeIn.finalInterrupts(trimmed)) {
        log.info("Pipeline replacing in-flight turn", { sid: deps.sid });
        deps.onInterrupted();
        deps.abortInFlightTurn();
        deps.edgeGate.release();
        callbacks.report({ type: "reply.cancelled" });
      }
      // Commit the turn immediately: endpointing (aggregating a disfluent
      // utterance's pauses into one final) is the STT provider's job — the
      // AssemblyAI opener sets `min_turn_silence` for exactly this.
      speechEdges.speechEnded();
      deps.commitUserTurn(trimmed);
    },
  };
}
