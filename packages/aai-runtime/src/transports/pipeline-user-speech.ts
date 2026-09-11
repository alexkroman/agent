// Copyright 2026 the AAI authors. MIT license.
// The WIRING of the pipeline transport's user-activity machinery: the silence
// nudger, the false-interruption recovery latch (whose tail tracker and resume
// prompts live in pipeline-recovery.ts), the speaking edges
// (pipeline-speech-edges.ts), the low-confidence gate
// (pipeline-low-confidence.ts), and the predicates every one of those is built
// from. What the handlers DO with a transcript is pipeline-stt-handlers.ts.

import type { ResolvedLowConfidence } from "@alexkroman1/aai/host-internal";
import { MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES } from "@alexkroman1/aai/host-internal";
import { DEFAULT_SILENCE_PROMPT } from "@alexkroman1/aai/internal";
import type { Logger } from "../runtime-config.ts";
import { createLowConfidenceGate, modelTranscript } from "./pipeline-low-confidence.ts";
import {
  createFalseInterruptionRecovery,
  type FalseInterruptionRecovery,
} from "./pipeline-recovery.ts";
import { createSilenceNudger, type SilenceNudger } from "./pipeline-silence.ts";
import type { SpeechEdgeTracker } from "./pipeline-speech-edges.ts";
import { createGatedSpeechEdges, createSpeechEdgeTracker } from "./pipeline-speech-edges.ts";
import {
  createSttEventHandlers,
  type SpeculationHooks,
  type SttEventHandlers,
} from "./pipeline-stt-handlers.ts";
import type { TransportCallbacks } from "./types.ts";

// Re-exported: both types are part of this module's own signatures, and a
// consumer should not have to know which half of the split declares them.
export type { SpeculationHooks, SttEventHandlers } from "./pipeline-stt-handlers.ts";

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
  /** Interim words required to barge in — per STATE, so a thunk. */
  minBargeInWords: () => number;
  /** Sustained-speech gate for interim-triggered barge-in; 0 disables. Per state too. */
  interruptionMinDurationMs: () => number;
  /** Preemptive generation, or a no-op controller when the flag is off. */
  speculation: SpeculationHooks;
  /** `AgentDef.lowConfidence`, resolved; absent when the agent declares none. */
  lowConfidence: ResolvedLowConfidence | undefined;
  /** Speak one sentence on the transport's own behalf, running no turn. */
  speakClarification(text: string): void;
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
  /** Has this reply sent real speech, as opposed to dead-air filler? */
  hasSpokenRecordable(): boolean;
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
  /**
   * Is the agent SPEAKING — as opposed to merely making noise?
   *
   * Filler is not speaking, and the `hasSpokenRecordable` term is what makes
   * that true of the predicate: without it a caller talking over a holding
   * phrase counted as interrupting a reply, and the abort destroyed the reply
   * being generated behind it. `HeardTracker.spokeRecordable` carries the
   * measurement and the argument.
   */
  const agentIsSpeaking = (): boolean =>
    (deps.isPlaybackPending() || (deps.isTurnInFlight() && deps.hasTurnSpoken())) &&
    deps.hasSpokenRecordable();

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
    hasSpokenRecordable: deps.hasSpokenRecordable,
    abortInFlightTurn: deps.abortInFlightTurn,
    tailResumePrompt: deps.tailResumePrompt,
    speechEdges,
    edgeGate,
    recovery,
    nudger,
    callbacks,
    speculation: deps.speculation,
    // The gate is built HERE because it needs this module's recovery latch and
    // speaking edges, and `undefined` from the factory is what the handler
    // reads as "commit every final". See pipeline-low-confidence.ts.
    lowConfidence: createLowConfidenceGate({
      policy: deps.lowConfidence,
      log,
      sid,
      retireSpeculation: () => deps.speculation.onUtteranceIdle(),
      clearRecovery: () => recovery.clear(),
      endSpeech: () => speechEdges.speechEnded(),
      speakClarification: deps.speakClarification,
    }),
    commitUserTurn(text: string, note?: string): void {
      // The model's copy carries the annotations and the client's and
      // history's stay verbatim — `modelTranscript` owns both halves of that
      // rule, and the measurement behind the spelled one.
      const forModel = modelTranscript(text, note);
      // Debug trace (AAI_DEBUG=1): `forModel` is verbatim what the turn prompts
      // the LLM with, so it stays the ground truth for "did the model see it?".
      log.debug("Pipeline turn committed", { sid, text: forModel });
      callbacks.report({ type: "user-transcript.committed", text });
      deps.runChainedTurn(forModel, "Pipeline turn crashed");
    },
    minBargeInWords: deps.minBargeInWords,
    interruptionMinDurationMs: deps.interruptionMinDurationMs,
    log,
    sid,
  });

  return { nudger, recovery, speechEdges, sttEvents };
}
