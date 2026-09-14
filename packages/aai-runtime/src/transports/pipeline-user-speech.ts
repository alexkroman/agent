// Copyright 2026 the AAI authors. MIT license.
// The WIRING of the pipeline transport's user-activity machinery: the silence
// nudger, the false-interruption recovery latch (whose tail tracker and resume
// prompts live in pipeline-recovery.ts), the speaking edges
// (pipeline-speech-edges.ts), and the predicates every one of those is built
// from. What the handlers DO with a transcript is pipeline-stt-handlers.ts.

import { MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES } from "@alexkroman1/aai/host-internal";
import { DEFAULT_SILENCE_PROMPT } from "@alexkroman1/aai/internal";
import type { Logger } from "../runtime-config.ts";
import { createAgentSpeakingPredicate } from "./pipeline-barge-in-policy.ts";
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
  /** A real interruption fired: arm the post-interruption audio block. */
  onInterrupted(): void;
  /** Preemptive generation, or a no-op controller when the flag is off. */
  speculation: SpeculationHooks;
  /** Speak one sentence on the transport's own behalf, running no turn. */
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
  // Does the agent HAVE the floor? One definition, two readers — see
  // createAgentSpeakingPredicate for why that matters and what each term of it
  // is for.
  const agentIsSpeaking = createAgentSpeakingPredicate(deps);

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
    commitUserTurn(text: string): void {
      // Debug trace (AAI_DEBUG=1): verbatim what the turn prompts the LLM with.
      log.debug("Pipeline turn committed", { sid, text });
      callbacks.report({ type: "user-transcript.committed", text });
      deps.runChainedTurn(text, "Pipeline turn crashed");
    },
    minBargeInWords: deps.minBargeInWords,
    interruptionMinDurationMs: deps.interruptionMinDurationMs,
    onInterrupted: deps.onInterrupted,
    log,
    sid,
  });

  return { nudger, recovery, speechEdges, sttEvents };
}
