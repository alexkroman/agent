// Copyright 2026 the AAI authors. MIT license.
// User-speech handling for the pipeline transport: speaking-edge detection
// (pipeline mode has no VAD, so speech_started/speech_stopped derive from the
// STT transcript stream) and the STT partial/final handlers that drive it —
// including when to arm false-interruption recovery (whose timer, tail
// tracker, and resume prompts live in pipeline-recovery.ts).

import {
  DEFAULT_FALSE_INTERRUPTION_PROMPT,
  DEFAULT_SILENCE_PROMPT,
  MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES,
} from "../../sdk/constants.ts";
import { createRestartableTimer } from "../_timer.ts";
import type { Logger } from "../runtime-config.ts";
import {
  createFalseInterruptionRecovery,
  type FalseInterruptionRecovery,
} from "./pipeline-recovery.ts";
import { createSilenceNudger, type SilenceNudger } from "./pipeline-silence.ts";
import { hasMinWords, scanWords } from "./pipeline-text.ts";
import type { TransportCallbacks } from "./types.ts";

/**
 * Edge-detect "user is speaking" from the STT transcript stream: the first
 * partial/final of an utterance fires `onSpeechStarted`, and the utterance
 * committing (or resolving as a false interruption) fires `onSpeechStopped`.
 */
export interface SpeechEdgeTracker {
  /**
   * A non-empty partial or final arrived — open the speaking edge (the
   * `onSpeechStarted` emit is idempotent) and restart the idle watchdog.
   */
  speechStarted(): void;
  /** The utterance resolved (commit / false-alarm) — close the edge (idempotent). */
  speechEnded(): void;
  /**
   * How long the current utterance has been running (ms since the edge
   * opened), or 0 when the user is not speaking. Drives the
   * `interruptionMinDurationMs` barge-in gate.
   */
  durationMs(): number;
  /** Forget the current edge without emitting (session reset / teardown). */
  reset(): void;
}

/**
 * Create a {@link SpeechEdgeTracker} bound to the transport callbacks.
 *
 * `idleTimeoutMs` is a watchdog, not the primary close path: a genuine
 * utterance closes the edge when its final commits. But an STT partial
 * that never reaches a non-empty final (noise, a hallucinated interim) would
 * otherwise leave the edge open for the rest of the session — `speech_stopped`
 * never firing, and a stale `startedAtMs` making {@link durationMs} grow
 * without bound so the `interruptionMinDurationMs` gate always passes. The
 * watchdog restarts on every partial, so it only fires once the transcript
 * stream has actually gone quiet.
 *
 * That makes the watchdog the transport's one signal for "this utterance
 * produced no final and never will", which is why `onIdle` exists: it is what
 * releases a deferred false-interruption resume (see pipeline-recovery.ts).
 * `onIdle` fires ONLY from the watchdog — never from the commit path's
 * `speechEnded()`, where a turn did commit and a resume must not run.
 */
export function createSpeechEdgeTracker(
  callbacks: {
    onSpeechStarted(): void;
    onSpeechStopped(): void;
  },
  opts: {
    idleTimeoutMs: number;
    /** The open edge went quiet without committing a turn. */
    onIdle?: (() => void) | undefined;
  },
): SpeechEdgeTracker {
  let speaking = false;
  let startedAtMs = 0;
  const idleWatchdog = createRestartableTimer(() => {
    if (!speaking) return;
    endSpeech();
    opts.onIdle?.();
  });

  function endSpeech(): void {
    idleWatchdog.clear();
    if (!speaking) return;
    speaking = false;
    callbacks.onSpeechStopped();
  }

  return {
    speechStarted(): void {
      // Restart the watchdog on every partial, including ones that don't open
      // the edge — quiet, not "no longer the first partial", is what ends it.
      idleWatchdog.arm(opts.idleTimeoutMs);
      if (speaking) return;
      speaking = true;
      startedAtMs = Date.now();
      callbacks.onSpeechStarted();
    },
    speechEnded: endSpeech,
    durationMs(): number {
      return speaking ? Date.now() - startedAtMs : 0;
    },
    reset(): void {
      idleWatchdog.clear();
      speaking = false;
    },
  };
}

/** STT transcript-stream handlers. See {@link createSttEventHandlers}. */
export interface SttEventHandlers {
  /** An interim transcript arrived. */
  onSttPartial(text: string): void;
  /** A committed transcript arrived. */
  onSttFinal(text: string): void;
}

/**
 * Turn the STT transcript stream into speaking edges, live captions, barge-in
 * decisions and committed turns.
 *
 * Split out of the transport so the barge-in policy — which is all threshold
 * and ordering rules rather than turn orchestration — reads on its own. The
 * transport's mutable turn state arrives as the `isTurnInFlight` /
 * `hasTurnSpoken` / `isPlaybackPending` predicates rather than as captured
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
  /** True while forwarded audio may still be playing client-side. */
  isPlaybackPending: () => boolean;
  /** Abort the in-flight turn and cancel TTS playback. */
  abortInFlightTurn: () => void;
  /**
   * Resume prompt for a barge-in on the client playback tail — the reply
   * finished server-side but its audio was still playing out. `undefined` when
   * the caller had essentially heard it all (then a cut costs nothing worth a
   * resume turn). Read BEFORE the abort: aborting resets the playback clock
   * this estimate is built from.
   */
  tailResumePrompt: () => string | undefined;
  speechEdges: SpeechEdgeTracker;
  recovery: FalseInterruptionRecovery;
  nudger: SilenceNudger;
  callbacks: {
    onCancelled(): void;
    onUserTranscriptPartial?: ((text: string) => void) | undefined;
  };
  /** Commit a user turn: emit the transcript and run the chained reply. */
  commitUserTurn: (text: string) => void;
  /** Interim words required to barge in. */
  minBargeInWords: number;
  /** Sustained-speech gate for interim-triggered barge-in; 0 disables. */
  interruptionMinDurationMs: number;
  log: Logger;
  sid: string;
}): SttEventHandlers {
  const { speechEdges, recovery, nudger, callbacks, log } = deps;

  /**
   * Is the agent actually speaking right now — audio already emitted for the
   * in-flight turn, or forwarded audio still playing out client-side?
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

  /**
   * Decide, BEFORE the abort, how a partial-triggered barge-in recovers from a
   * false alarm, returning the arm to run after it. Both barge-in shapes can
   * recover, each with its own resume prompt: an aborted in-flight turn
   * continues from its `[interrupted]` history marker, while a turn that
   * already finished server-side (client playback tail) has its full text in
   * history with no marker, so its prompt embeds the estimated cut point —
   * captured here because the abort resets the playback clock that estimate
   * reads. A fully-heard tail (`undefined`) arms nothing: there is nothing
   * left to resume.
   */
  function bargeInRecoveryArm(): () => void {
    // "In flight" alone is the wrong classifier: the turn controller stays
    // non-null through the TTS drain, which for a sentence-flushing adapter
    // lasts as long as the remaining synthesis. A turn in that window already
    // persisted its FULL text with no [interrupted] marker, so the mid-turn
    // prompt would tell the model to continue past an ending it produced —
    // it repeats itself or rambles. Only a turn whose body is still streaming
    // resumes from the marker; everything else is a playback cut.
    if (deps.isTurnInFlight() && !deps.isTurnDraining()) {
      return () => recovery.arm(DEFAULT_FALSE_INTERRUPTION_PROMPT);
    }
    const tailPrompt = deps.tailResumePrompt();
    if (tailPrompt === undefined) return () => undefined;
    return () => recovery.arm(tailPrompt);
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
    onSttPartial(text: string): void {
      if (deps.isTerminated()) return;
      // Debug trace (AAI_DEBUG=1): partials are the only record of a word STT
      // heard mid-utterance and then dropped from its final, which otherwise
      // looks like the LLM inventing a tool argument out of nowhere.
      log.debug("Pipeline STT partial", { sid: deps.sid, text });
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
        if (words >= 1) callbacks.onUserTranscriptPartial?.(text);
      };
      if (words >= 1) {
        speechEdges.speechStarted();
        // Still talking through a pending recovery window: push the deadline out
        // so the resume can't fire over a user who barged in and kept going.
        // With providers that only emit a final at end-of-turn (AssemblyAI), the
        // window would otherwise elapse mid-utterance.
        if (recovery.pending()) recovery.arm();
      }
      if (!partialTriggersBargeIn(words)) {
        emitPartial();
        return;
      }
      log.info("Pipeline barge-in", { sid: deps.sid });
      const armRecovery = bargeInRecoveryArm();
      deps.abortInFlightTurn();
      callbacks.onCancelled();
      emitPartial();
      armRecovery();
    },

    onSttFinal(text: string): void {
      if (deps.isTerminated()) return;
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      // Debug trace (AAI_DEBUG=1): pairs with "Pipeline turn committed" below.
      // Finals that differ from the commit locate a loss in aggregation; a
      // commit that matches the finals locates it in STT instead.
      log.debug("Pipeline STT final", { sid: deps.sid, text: trimmed });
      // Real speech reached a final — whatever barge-in preceded it was not a
      // false interruption; a genuine turn commits below. Restores the
      // consecutive-resume budget too: the user is demonstrably present.
      recovery.onUserTurn();
      // The recovery window may have already fired (a short utterance whose
      // only STT event is this final loses the race to the timer): a resume
      // turn is then in flight covering an "interruption" this final just
      // proved genuine. Abort it while it is still silent — otherwise the
      // agent first speaks a full continuation of the interrupted reply and
      // only then answers the user. A resume that already spoke falls through
      // to the ordinary barge-in rules below. This cannot starve replies the
      // way aborting unspoken turns generally would: only resume turns are
      // aborted here, and each abort is caused by a committed user turn.
      if (deps.isResumeTurnInFlight() && !deps.hasTurnSpoken()) {
        log.info("Pipeline resume mooted by committed user turn", { sid: deps.sid });
        deps.abortInFlightTurn();
        callbacks.onCancelled();
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
        callbacks.onCancelled();
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
  callbacks: Pick<
    TransportCallbacks,
    | "onCancelled"
    | "onUserTranscript"
    | "onUserTranscriptPartial"
    | "onSpeechStarted"
    | "onSpeechStopped"
  >;
  /** Silence-nudge window (ms); unset/non-positive disables the nudger. */
  silenceTimeoutMs: number | undefined;
  /** Synthetic user message a nudge injects; defaults to DEFAULT_SILENCE_PROMPT. */
  silencePrompt: string | undefined;
  /** False-interruption recovery window (ms); 0 disables. */
  falseInterruptionTimeoutMs: number;
  /**
   * Speaking-edge idle watchdog (ms). Also the deferred-resume release, so it
   * bounds false-interruption recovery latency — see DEFAULT_SPEECH_IDLE_TIMEOUT_MS.
   */
  speechIdleTimeoutMs: number;
  /** Interim words required to barge in. */
  minBargeInWords: number;
  /** Sustained-speech gate for interim-triggered barge-in; 0 disables. */
  interruptionMinDurationMs: number;
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

  // Pipeline mode has no VAD: speech_started/speech_stopped derive from the
  // STT transcript stream (see createSpeechEdgeTracker above). `onIdle` — the
  // utterance going quiet with no final — is what releases a deferred resume;
  // `recovery` is declared below and bound late, so the reference resolves when
  // the watchdog fires rather than at construction.
  const speechEdges = createSpeechEdgeTracker(callbacks, {
    idleTimeoutMs: deps.speechIdleTimeoutMs,
    onIdle: () => recovery.onUtteranceEnded(),
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
  // The prompt was chosen when the window was armed: the default continuation
  // prompt for an aborted in-flight turn (its spoken-so-far text is in history
  // marked `[interrupted]`), the cut-point prompt for a playback-tail cut.
  const recovery = createFalseInterruptionRecovery({
    timeoutMs: deps.falseInterruptionTimeoutMs,
    maxConsecutive: MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES,
    isActive: () => !deps.isTerminated(),
    isBusy,
    // An open speaking edge means STT may still be holding a final back for its
    // endpointing window; resuming into that races the caller's real turn.
    isUtteranceInProgress: () => speechEdges.durationMs() > 0,
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
    isPlaybackPending: deps.isPlaybackPending,
    abortInFlightTurn: deps.abortInFlightTurn,
    tailResumePrompt: deps.tailResumePrompt,
    speechEdges,
    recovery,
    nudger,
    callbacks,
    commitUserTurn(text: string): void {
      // Debug trace (AAI_DEBUG=1): this is verbatim the text the turn prompts
      // the LLM with, so it is the ground truth for "did the model see it?".
      log.debug("Pipeline turn committed", { sid, text });
      callbacks.onUserTranscript(text);
      deps.runChainedTurn(text, "Pipeline turn crashed");
    },
    minBargeInWords: deps.minBargeInWords,
    interruptionMinDurationMs: deps.interruptionMinDurationMs,
    log,
    sid,
  });

  return { nudger, recovery, speechEdges, sttEvents };
}
