// Copyright 2026 the AAI authors. MIT license.
// User-speech handling for the pipeline transport: the STT partial/final
// handlers that turn the transcript stream into barge-in decisions and
// committed turns, and the wiring of the machinery they drive — including
// when to arm false-interruption recovery (whose latch, tail tracker, and
// resume prompts live in pipeline-recovery.ts). The speaking edges those
// handlers emit through live in pipeline-speech-edges.ts.

import type { SttTurnMeta } from "@alexkroman1/aai/host-internal";
import {
  DEFAULT_FALSE_INTERRUPTION_PROMPT,
  MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES,
} from "@alexkroman1/aai/host-internal";
import { DEFAULT_SILENCE_PROMPT } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { debugPartialsEnabled, type Logger } from "../runtime-config.ts";
import {
  createFalseInterruptionRecovery,
  type FalseInterruptionRecovery,
} from "./pipeline-recovery.ts";
import { createSilenceNudger, type SilenceNudger } from "./pipeline-silence.ts";
import type { SpeculationController } from "./pipeline-speculation.ts";
import {
  createGatedSpeechEdges,
  createSpeechEdgeTracker,
  type GatedSpeechEdges,
  type SpeechEdgeTracker,
} from "./pipeline-speech-edges.ts";
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
function createSttEventHandlers(deps: {
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
  /** Commit a user turn: emit the transcript and run the chained reply. */
  commitUserTurn: (text: string) => void;
  /** Preemptive generation, or a no-op controller when the flag is off. */
  speculation: SpeculationHooks;
  /** Interim words required to barge in. */
  minBargeInWords: number;
  /** Sustained-speech gate for interim-triggered barge-in; 0 disables. */
  interruptionMinDurationMs: number;
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
    if (words < deps.minBargeInWords) return false;
    // Duration gate (interim-only): require sustained speech since the
    // utterance's first partial before cutting the agent off. A committed
    // final barging in via onSttFinal is never duration-gated.
    const gate = deps.interruptionMinDurationMs;
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
      const words = scanWords(text, Math.max(deps.minBargeInWords, 1));
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

    onSttFinal(text: string, _meta?: SttTurnMeta): void {
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
      // Interrupt the agent's reply only when it is actually speaking and the
      // utterance is clearly intentional (>= threshold). Anything else does NOT
      // interrupt — the turn is answered once the reply finishes (chainTurn
      // defers it), so neither short answers ("yes", a ZIP) spoken over the
      // agent nor re-prompts into a not-yet-spoken reply are lost.
      if (agentIsSpeaking() && hasMinWords(trimmed, deps.minBargeInWords)) {
        log.info("Pipeline replacing in-flight turn", { sid: deps.sid });
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

/** The transport's user-activity machinery — see {@link createUserActivity}. */
export interface UserActivity {
  nudger: SilenceNudger;
  recovery: FalseInterruptionRecovery;
  speechEdges: SpeechEdgeTracker;
  sttEvents: SttEventHandlers;
}

/**
 * Wire up the pipeline transport's user-activity machinery: the silence
 * nudger, false-interruption recovery, speaking-edge tracker, and the STT
 * event handlers that drive them. Pulled out of `pipeline-transport.ts` so
 * the transport keeps turn orchestration and this module keeps everything
 * downstream of the user's voice. The transport's mutable turn state arrives
 * as predicates, and every turn these components launch goes through
 * `runChainedTurn` — which is where the transport applies its queued-turn
 * invalidation gate (pipeline-turn-gate.ts).
 */
export function createUserActivity(deps: {
  log: Logger;
  sid: string;
  callbacks: Pick<TransportCallbacks, "report">;
  /** Silence-nudge window (ms); unset/non-positive disables the nudger. */
  silenceTimeoutMs: number | undefined;
  /** Synthetic user message a nudge injects; defaults to DEFAULT_SILENCE_PROMPT. */
  silencePrompt: string | undefined;
  /** Resume a barged-in reply when the interruption commits no user turn. */
  resumeFalseInterruption: boolean;
  /**
   * Speaking-edge idle watchdog (ms), and with it THE false-interruption
   * resume deadline — the watchdog is what fires the resume, so 0 disables
   * recovery outright. See DEFAULT_SPEECH_IDLE_TIMEOUT_MS.
   */
  speechIdleTimeoutMs: number;
  /** Interim words required to barge in. */
  minBargeInWords: number;
  /** Sustained-speech gate for interim-triggered barge-in; 0 disables. */
  interruptionMinDurationMs: number;
  /** Preemptive generation, or a no-op controller when the flag is off. */
  speculation: SpeculationHooks;
  isTerminated(): boolean;
  /** False once the transport terminated or the session aborted (nudger gate). */
  isSessionActive(): boolean;
  isTurnInFlight(): boolean;
  /** True while the in-flight turn's body has finished and only its TTS drain remains. */
  isTurnDraining(): boolean;
  /** True while the in-flight turn is a false-interruption resume. */
  isResumeTurnInFlight(): boolean;
  /** True once the in-flight turn has put audio on the wire. */
  hasTurnSpoken(): boolean;
  isPlaybackPending(): boolean;
  abortInFlightTurn(): void;
  /** Cut-point resume prompt for a playback-tail barge-in — see {@link SttEventHandlers}. */
  tailResumePrompt(): string | undefined;
  /**
   * Chain `runTurn(text)` behind the active turn, logging crashes as
   * `crashLabel`. `synthetic` marks `text` as an injected instruction rather
   * than something the caller said, so an abort that leaves the turn with
   * nothing to show for it can drop the prompt from history again.
   */
  runChainedTurn(
    text: string,
    crashLabel: string,
    kind?: { isResume?: boolean; synthetic?: boolean },
  ): void;
}): UserActivity {
  const { log, sid, callbacks } = deps;
  const isBusy = (): boolean => deps.isTurnInFlight() || deps.isPlaybackPending();
  /**
   * Is the agent actually speaking right now — audio already emitted for the
   * in-flight turn, or forwarded audio still playing out client-side?
   *
   * Defined ONCE and passed to both readers (the outward speaking-edge gate
   * and the STT handlers' barge-in rules), because the two must agree by
   * construction: a gate that holds `speech_started` back on one definition
   * while a barge-in fires on another is a client told the agent yielded by a
   * transport that decided it had not.
   *
   * Deliberately not "a turn is in flight". A turn that has yet to emit audio
   * cannot be spoken over, so a barge-in has nothing to stop; all it would do
   * is discard the reply mid-computation and restart a strictly slower one (the
   * abandoned work redone on top of a longer history). A user re-prompting into
   * that silence on any regular cadence would then starve the reply
   * indefinitely, every restart outliving the next re-prompt. Utterances
   * arriving before the agent speaks take the deferral path instead: they
   * commit as chained turns and are answered once the reply in progress lands.
   *
   * Once a turn has spoken it keeps the floor for the rest of its run, so a
   * mid-reply TTS stall (playback draining while more text is still streaming)
   * does not silently reopen the pre-audio window.
   */
  const agentIsSpeaking = (): boolean =>
    deps.isPlaybackPending() || (deps.isTurnInFlight() && deps.hasTurnSpoken());

  // Hold `speech_started` back while the agent has the floor, so the event
  // means "the agent is yielding" on both transports — see createGatedSpeechEdges.
  const edgeGate = createGatedSpeechEdges({ report: callbacks.report, agentIsSpeaking });

  // Pipeline mode has no VAD: speech_started/speech_stopped derive from the
  // STT transcript stream (see createSpeechEdgeTracker above). `onIdle` — the
  // utterance going quiet with no final — IS the false-interruption recovery
  // signal, the only one the transport can observe; `recovery` is declared
  // below and bound late, so the reference resolves when the watchdog fires
  // rather than at construction.
  const speechEdges = createSpeechEdgeTracker(edgeGate, {
    idleTimeoutMs: deps.speechIdleTimeoutMs,
    onIdle: () => {
      // The same edge that arms a false-interruption resume also retires any
      // speculation: this utterance produced no final, so nothing can ever
      // adopt it — and a resume turn must never be allowed to pick one up (its
      // prompt is a synthetic continuation, not the words this was built from).
      deps.speculation.onUtteranceIdle();
      recovery.onUtteranceEnded();
    },
  });

  // Silence nudge: `silencePrompt` becomes a synthetic user message (in LLM
  // history, never a user transcript). Countdown/budget rules: pipeline-silence.ts.
  const silencePrompt = deps.silencePrompt ?? DEFAULT_SILENCE_PROMPT;
  const nudger = createSilenceNudger({
    timeoutMs: deps.silenceTimeoutMs,
    isActive: deps.isSessionActive,
    isTurnInFlight: isBusy,
    onNudge(consecutive) {
      log.info("Pipeline silence nudge", { sid, consecutive });
      deps.runChainedTurn(silencePrompt, "Pipeline silence nudge crashed", { synthetic: true });
    },
  });

  // Resume a barged-in reply when the interruption never commits a user turn.
  // The prompt was chosen when the latch was armed: the cut-point prompt where
  // one is known, otherwise the default continuation prompt for an aborted
  // in-flight turn (its spoken-so-far text is in history marked
  // `[interrupted]`). The latch holds no deadline of its own — `speechEdges`'
  // idle watchdog above fires it.
  const recovery = createFalseInterruptionRecovery({
    enabled: deps.resumeFalseInterruption,
    maxConsecutive: MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES,
    isActive: () => !deps.isTerminated(),
    isBusy,
    onResume: (resumePrompt) => {
      log.info("Pipeline false-interruption resume", { sid });
      speechEdges.speechEnded();
      deps.runChainedTurn(resumePrompt, "Pipeline false-interruption resume crashed", {
        isResume: true,
        synthetic: true,
      });
    },
  });

  const sttEvents = createSttEventHandlers({
    isTerminated: deps.isTerminated,
    isTurnInFlight: deps.isTurnInFlight,
    isTurnDraining: deps.isTurnDraining,
    isResumeTurnInFlight: deps.isResumeTurnInFlight,
    hasTurnSpoken: deps.hasTurnSpoken,
    agentIsSpeaking,
    abortInFlightTurn: deps.abortInFlightTurn,
    tailResumePrompt: deps.tailResumePrompt,
    speechEdges,
    edgeGate,
    recovery,
    nudger,
    callbacks,
    speculation: deps.speculation,
    commitUserTurn(text: string): void {
      // Debug trace (AAI_DEBUG=1): this is verbatim the text the turn prompts
      // the LLM with, so it is the ground truth for "did the model see it?".
      log.debug("Pipeline turn committed", { sid, text });
      callbacks.report({ type: "user-transcript.committed", text });
      deps.runChainedTurn(text, "Pipeline turn crashed");
    },
    minBargeInWords: deps.minBargeInWords,
    interruptionMinDurationMs: deps.interruptionMinDurationMs,
    log,
    sid,
  });

  return { nudger, recovery, speechEdges, sttEvents };
}
