// Copyright 2026 the AAI authors. MIT license.
// User-speech handling for the pipeline transport: speaking-edge detection
// (pipeline mode has no VAD, so speech_started/speech_stopped derive from the
// STT transcript stream), false-interruption recovery (resume a barged-in reply
// when the interruption never commits a turn), and the STT partial/final
// handlers that drive both from the provider's transcript stream.

import { createRestartableTimer } from "../_timer.ts";
import type { Logger } from "../runtime-config.ts";
import type { EndpointSettler } from "./pipeline-endpointing.ts";
import type { SilenceNudger } from "./pipeline-silence.ts";
import { hasMinWords, scanWords } from "./pipeline-text.ts";

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
 * utterance closes the edge when the settler commits it. But an STT partial
 * that never reaches a non-empty final (noise, a hallucinated interim) would
 * otherwise leave the edge open for the rest of the session — `speech_stopped`
 * never firing, and a stale `startedAtMs` making {@link durationMs} grow
 * without bound so the `interruptionMinDurationMs` gate always passes. The
 * watchdog restarts on every partial, so it only fires once the transcript
 * stream has actually gone quiet.
 */
export function createSpeechEdgeTracker(
  callbacks: {
    onSpeechStarted(): void;
    onSpeechStopped(): void;
  },
  opts: { idleTimeoutMs: number },
): SpeechEdgeTracker {
  let speaking = false;
  let startedAtMs = 0;
  const idleWatchdog = createRestartableTimer(() => endSpeech());

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

/**
 * False-interruption recovery timer. A partial-triggered barge-in aborts the
 * in-flight reply, but STT noise or a hallucinated partial may never produce
 * a final — the settler commits nothing and the agent falls silent
 * mid-thought. `arm()` starts the recovery window after such a barge-in;
 * `clear()` cancels it when real speech commits (or the client cancels). If
 * the window elapses while the transport is idle, `onResume` runs the
 * continuation turn.
 */
export interface FalseInterruptionRecovery {
  /**
   * Start (or restart) the recovery window. No-op when the timeout is 0 or the
   * consecutive-resume budget is spent.
   */
  arm(): void;
  /** Cancel a pending recovery window, keeping the consecutive-resume budget. */
  clear(): void;
  /** Is a recovery window currently pending? Drives re-arming on continued speech. */
  pending(): boolean;
  /**
   * A real user turn committed (STT final) — the barge-in that preceded it was
   * genuine. Cancel the window and restore the budget.
   */
  onUserTurn(): void;
}

/** Create a {@link FalseInterruptionRecovery}. */
export function createFalseInterruptionRecovery(opts: {
  /** Recovery window in ms; 0 (or negative) disables recovery entirely. */
  timeoutMs: number;
  /** Max back-to-back resumes before the user must speak again. */
  maxConsecutive: number;
  /** False once the transport terminated — a fired timer then does nothing. */
  isActive: () => boolean;
  /**
   * True while a turn is in flight or client audio may still be playing —
   * something else took the floor, so the interruption resolved itself.
   */
  isBusy: () => boolean;
  /** Run the resume turn. Only called when active and not busy. */
  onResume: () => void;
}): FalseInterruptionRecovery {
  let consecutive = 0;
  const window = createRestartableTimer(() => fire());

  function arm(): void {
    // Budget spent: persistent cross-talk must not loop barge-in → resume →
    // barge-in indefinitely, each cycle costing a full LLM+TTS turn and
    // another copy of the continuation prompt in history.
    if (consecutive >= opts.maxConsecutive) return;
    window.arm(opts.timeoutMs);
  }

  function fire(): void {
    if (!opts.isActive()) return;
    if (opts.isBusy()) return;
    if (consecutive >= opts.maxConsecutive) return;
    consecutive++;
    opts.onResume();
  }

  return {
    arm,
    clear: window.clear,
    pending: window.pending,
    onUserTurn(): void {
      consecutive = 0;
      window.clear();
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
 * decisions and settled turns.
 *
 * Split out of the transport so the barge-in policy — which is all threshold
 * and ordering rules rather than turn orchestration — reads on its own. The
 * transport's mutable turn state arrives as the `isTurnInFlight` /
 * `isPlaybackPending` predicates rather than as captured variables, so this
 * module never needs to know how a turn is represented.
 */
export function createSttEventHandlers(deps: {
  /** True once the transport terminated — every inbound event is then dropped. */
  isTerminated: () => boolean;
  /** True while a turn is in flight server-side (an abortable reply exists). */
  isTurnInFlight: () => boolean;
  /** True while forwarded audio may still be playing client-side. */
  isPlaybackPending: () => boolean;
  /** Abort the in-flight turn and cancel TTS playback. */
  abortInFlightTurn: () => void;
  speechEdges: SpeechEdgeTracker;
  recovery: FalseInterruptionRecovery;
  settler: EndpointSettler;
  nudger: SilenceNudger;
  callbacks: {
    onCancelled(): void;
    onUserTranscriptPartial?: ((text: string) => void) | undefined;
  };
  /** Interim words required to barge in. */
  minBargeInWords: number;
  /** Sustained-speech gate for interim-triggered barge-in; 0 disables. */
  interruptionMinDurationMs: number;
  log: Logger;
  sid: string;
}): SttEventHandlers {
  const { speechEdges, recovery, settler, nudger, callbacks, log } = deps;

  /** Is the agent currently holding the floor (server-side turn or client audio)? */
  const agentHasFloor = (): boolean => deps.isTurnInFlight() || deps.isPlaybackPending();

  /** Should this interim transcript interrupt the agent right now? */
  function partialTriggersBargeIn(words: number): boolean {
    if (!agentHasFloor()) return false;
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
      // User speech proves presence: reset the nudge budget, restart the window.
      nudger.onUserSpeech();
      // Counted once, with a bounded scan: every consumer here is a threshold
      // check — the speaking edge, caption emit and settler extension need
      // >= 1, the barge-in gate needs >= minBargeInWords — so the scan stops
      // at max(minBargeInWords, 1) instead of walking the whole partial,
      // which grows to full-utterance length as the user keeps speaking.
      const words = scanWords(text, Math.max(deps.minBargeInWords, 1));
      // Live captions: forward the interim transcript as-is. The committed turn
      // still arrives via onUserTranscript once the settler fires. Emitted after
      // any barge-in below, because the client's `cancelled` handler clears
      // userTranscript — emitting first would blank the caption it just set.
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
      // A partial while an utterance is buffered means the speaker resumed after
      // a pause: extend the settle window so the continuation aggregates into
      // the same turn instead of the pre-pause fragment committing on its own.
      if (settler.extendOnPartial(words) || !partialTriggersBargeIn(words)) {
        emitPartial();
        return;
      }
      log.info("Pipeline barge-in", { sid: deps.sid });
      // Only an aborted in-flight turn can be resumed after a false alarm — its
      // spoken-so-far text lands in history marked `[interrupted]`. A turn that
      // already finished server-side (client playback tail) has no cut point to
      // continue from, so no recovery timer is armed for it.
      const wasTurnInFlight = deps.isTurnInFlight();
      deps.abortInFlightTurn();
      callbacks.onCancelled();
      emitPartial();
      if (wasTurnInFlight) recovery.arm();
    },

    onSttFinal(text: string): void {
      if (deps.isTerminated()) return;
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      // Real speech reached a final — whatever barge-in preceded it was not a
      // false interruption; the settler will commit a genuine turn. Restores the
      // consecutive-resume budget too: the user is demonstrably present.
      recovery.onUserTurn();
      // A final can arrive without any preceding partial (short utterances on
      // some STT providers) — make sure the speaking edge still fires.
      speechEdges.speechStarted();
      // The turn that follows (via the settler) re-arms the nudge on completion.
      nudger.onUserTurn();
      // Interrupt the agent's in-flight reply only for a clearly-intentional
      // (>= threshold) utterance. A shorter one does NOT interrupt — it is
      // buffered and answered once the reply finishes (chainTurn defers it),
      // so short answers ("yes", a ZIP) spoken over the agent aren't lost.
      if (agentHasFloor() && hasMinWords(trimmed, deps.minBargeInWords)) {
        log.info("Pipeline replacing in-flight turn", { sid: deps.sid });
        deps.abortInFlightTurn();
        callbacks.onCancelled();
      }
      settler.push(trimmed);
    },
  };
}
