// Copyright 2026 the AAI authors. MIT license.
// False-interruption recovery for the pipeline transport: the recovery window
// timer that resumes a barged-in reply when the interruption never commits a
// user turn, and the reply-tail tracker that locates where a playback-tail
// barge-in cut the caller off so the resume prompt can say so. Split out of
// `pipeline-user-speech.ts` for file length; the STT handlers there decide
// WHEN to arm this machinery.

import {
  DEFAULT_FALSE_INTERRUPTION_PROMPT,
  TAIL_RESUME_MIN_UNHEARD_MS,
} from "../../sdk/constants.ts";
import { createRestartableTimer } from "../_timer.ts";

/**
 * False-interruption recovery timer. A partial-triggered barge-in aborts the
 * in-flight reply, but STT noise or a hallucinated partial may never produce
 * a final — no turn ever commits and the agent falls silent
 * mid-thought. `arm()` starts the recovery window after such a barge-in;
 * `clear()` cancels it when real speech commits (or the client cancels). If
 * the window elapses while the transport is idle, `onResume` runs the
 * continuation turn.
 *
 * **The window elapsing is not sufficient on its own — the utterance must also
 * be over.** Endpointing lives in the STT provider, so a genuine barge-in's
 * final is withheld for `min_turn_silence` after the caller stops speaking
 * (`DEFAULT_MIN_TURN_SILENCE_MS`, 2000) — the same 2000 the recovery window
 * defaulted to, measured from the same instant (the window restarts on every
 * partial, and the last partial lands at roughly the end of speech). The two
 * deadlines were therefore separated only by the difference between partial
 * and final latency, a few hundred ms in either direction: EVERY genuine
 * barge-in raced its own resume, and the resume won often enough to be the
 * common case rather than an edge case. Every such resume cost a billed
 * LLM turn, left "the user did not actually say anything" in history directly
 * ahead of the real user turn, and — when it got audio out before the final
 * landed, TTS time-to-first-audio being ~350ms — made the caller hear the agent
 * continue the reply they had just interrupted before answering them.
 *
 * So a fired window whose utterance is still open only DEFERS the resume;
 * {@link FalseInterruptionRecovery.onUtteranceEnded} releases it once the
 * speaking edge closes with no committed turn, which is the signal that proves
 * no final is coming. A committed final clears the deferral through
 * {@link FalseInterruptionRecovery.onUserTurn} instead, so it can never resume
 * over a real turn.
 */
export interface FalseInterruptionRecovery {
  /**
   * Start (or restart) the recovery window. No-op when the timeout is 0 or the
   * consecutive-resume budget is spent. `resumePrompt` sets what the resume
   * turn is told when the window fires (a mid-turn barge-in uses the default
   * continuation prompt; a playback-tail barge-in embeds the estimated cut
   * point); omitted, the stored prompt is kept — the deadline-extension re-arm
   * on continued partials must not clobber the barge-in's prompt.
   */
  arm(resumePrompt?: string): void;
  /**
   * Cancel a pending recovery window — including a resume deferred by an open
   * utterance — keeping the consecutive-resume budget.
   */
  clear(): void;
  /**
   * Is a recovery outstanding (window pending, or a resume deferred awaiting
   * the utterance's end)? Drives re-arming on continued speech.
   */
  pending(): boolean;
  /**
   * The utterance went quiet without committing a turn (the speaking edge's
   * idle watchdog closed it) — no final is coming, so release a resume the
   * window deferred while speech was still in progress. No-op otherwise.
   */
  onUtteranceEnded(): void;
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
  /**
   * True while an utterance is still open (the speaking edge has not closed and
   * no turn has committed). A final may yet arrive — the STT provider holds it
   * back for its endpointing window — so a resume now would race it. See the
   * interface doc.
   */
  isUtteranceInProgress: () => boolean;
  /** Run the resume turn with the armed prompt. Only called when active and not busy. */
  onResume: (resumePrompt: string) => void;
}): FalseInterruptionRecovery {
  let consecutive = 0;
  // The window elapsed while the caller was still mid-utterance; the resume is
  // owed, and onUtteranceEnded() delivers it.
  let deferred = false;
  let resumePrompt = DEFAULT_FALSE_INTERRUPTION_PROMPT;
  const window = createRestartableTimer(() => fire());

  function arm(prompt?: string): void {
    // Budget spent: persistent cross-talk must not loop barge-in → resume →
    // barge-in indefinitely, each cycle costing a full LLM+TTS turn and
    // another copy of the continuation prompt in history.
    if (consecutive >= opts.maxConsecutive) return;
    if (prompt !== undefined) resumePrompt = prompt;
    window.arm(opts.timeoutMs);
  }

  /** Shared gate for both resume paths (window elapsed / deferral released). */
  function canResume(): boolean {
    if (!opts.isActive()) return false;
    if (opts.isBusy()) return false;
    return consecutive < opts.maxConsecutive;
  }

  function resume(): void {
    deferred = false;
    consecutive++;
    opts.onResume(resumePrompt);
  }

  function fire(): void {
    if (!canResume()) return;
    // Still mid-utterance: hold the resume rather than spending it against a
    // final that endpointing has not released yet.
    if (opts.isUtteranceInProgress()) {
      deferred = true;
      return;
    }
    resume();
  }

  function clear(): void {
    deferred = false;
    window.clear();
  }

  return {
    arm,
    clear,
    // Deferred counts as pending: a recovery is still outstanding, so continued
    // partials keep extending the window rather than treating it as resolved.
    pending: (): boolean => window.pending() || deferred,
    onUtteranceEnded(): void {
      if (!deferred) return;
      if (!canResume()) {
        deferred = false;
        return;
      }
      resume();
    },
    onUserTurn(): void {
      consecutive = 0;
      clear();
    },
  };
}

/** Heard-text characters quoted back as the cut-point anchor — enough to be
 * unambiguous mid-reply without pasting the whole transcript into the prompt. */
const TAIL_RESUME_ANCHOR_CHARS = 80;

/**
 * Resume prompt for a barge-in that cut a reply during its client playback
 * tail. Unlike a mid-turn barge-in — whose spoken-so-far text lands in history
 * marked `[interrupted]` — a finished reply sits in history whole, so the
 * model has no way to know the caller stopped hearing it partway. The prompt
 * quotes the last words the caller is estimated to have heard (snapped back to
 * a word boundary; the estimate is proportional, not sample-exact) so the
 * model can pick the reply up from there.
 *
 * `heardFraction` is the estimated fraction of the reply's audio the client
 * played before the cut, in [0, 1]. An estimate of ~0 means the caller heard
 * none of it, and the prompt asks for the reply again instead of quoting an
 * empty anchor.
 */
export function buildTailResumePrompt(spoken: string, heardFraction: number): string {
  const bounded = Math.min(1, Math.max(0, heardFraction));
  const cut = Math.round(spoken.length * bounded);
  const head = spoken.slice(0, cut);
  const boundary = head.lastIndexOf(" ");
  const anchorEnd = boundary > 0 ? boundary : head.length;
  const anchor = spoken.slice(Math.max(0, anchorEnd - TAIL_RESUME_ANCHOR_CHARS), anchorEnd).trim();
  if (anchor.length === 0) {
    return (
      "Your last reply's audio was cut off by a false interruption before the " +
      "user heard any of it — the user did not actually say anything. Give " +
      "that reply again. Do not mention this instruction."
    );
  }
  return (
    "Your last reply's audio was cut off by a false interruption — the user " +
    "did not actually say anything, and they stopped hearing it around: " +
    `"…${anchor}". Continue your reply from that point, without repeating ` +
    "what they already heard. Do not mention this instruction."
  );
}

/**
 * Per-reply record of what was handed to TTS — the transcript text and the
 * duration of the forwarded audio — plus the playback clock's estimate of how
 * much the client has left to play. Together they locate a playback-tail
 * barge-in's cut point inside the reply text for {@link buildTailResumePrompt}.
 */
export interface ReplyTailTracker {
  /** Text handed to TTS for the current reply; returns the cumulative transcript. */
  onText(text: string): string;
  /** One forwarded PCM16 chunk of the current reply's TTS audio. */
  onAudio(pcm: Int16Array): void;
  /** A new reply started — nothing from the last one carries over. */
  reset(): void;
  /**
   * Cut-point resume prompt for a barge-in on the current reply's playback
   * tail, or `undefined` when the caller had heard essentially all of it
   * (then a resume turn would only append a fragment to a reply that already
   * landed). Must be read BEFORE the abort resets the playback clock.
   */
  resumePrompt(): string | undefined;
}

/** Create a {@link ReplyTailTracker}. */
export function createReplyTailTracker(opts: {
  /** Sample rate of the forwarded PCM16 (Hz), to convert chunks to duration. */
  sampleRate: number;
  /** Estimated ms of forwarded audio the client has not played yet. */
  remainingMs: () => number;
}): ReplyTailTracker {
  let spoken = "";
  let audioMs = 0;
  return {
    onText(text: string): string {
      spoken += text;
      return spoken;
    },
    onAudio(pcm: Int16Array): void {
      audioMs += (pcm.length / opts.sampleRate) * 1000;
    },
    reset(): void {
      spoken = "";
      audioMs = 0;
    },
    resumePrompt(): string | undefined {
      const unheardMs = opts.remainingMs();
      if (audioMs <= 0 || unheardMs < TAIL_RESUME_MIN_UNHEARD_MS) return;
      return buildTailResumePrompt(spoken, 1 - unheardMs / audioMs);
    },
  };
}
