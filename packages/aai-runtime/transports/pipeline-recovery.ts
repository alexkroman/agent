// Copyright 2026 the AAI authors. MIT license.
// False-interruption recovery for the pipeline transport: the latch that
// resumes a barged-in reply when the interruption never commits a user turn,
// and the prompt that tells the resumed turn where the caller stopped hearing.
// Split out of `pipeline-user-speech.ts` for file length; the STT handlers
// there decide WHEN to arm this machinery. WHERE the caller stopped hearing is
// answered by `pipeline-heard.ts`, which owns that one cursor for both this
// prompt and history truncation.

import { TAIL_RESUME_MIN_UNHEARD_MS } from "@alexkroman1/aai/host-internal";

/**
 * False-interruption recovery latch. A partial-triggered barge-in aborts the
 * in-flight reply, but STT noise or a hallucinated partial may never produce a
 * final — no turn ever commits and the agent falls silent mid-thought.
 * `arm(prompt)` latches a resume after such a barge-in, `clear()` drops it when
 * the client cancels or the session ends, and {@link onUserTurn} drops it when
 * real speech commits. {@link onUtteranceEnded} is what fires it.
 *
 * **There is no timer here, and that is the whole design.** The transport
 * cannot pick a deadline of its own, because a genuine barge-in's final is
 * withheld by the STT provider for its endpointing window and the transport
 * receives an already-resolved `SttOpener` — it does not know that window. Any
 * shorter deadline therefore RACES the caller's real turn: with the recovery
 * window at its old 2000 ms default and `min_turn_silence` at 1600-2000,
 * measured from roughly the same instant, every genuine barge-in raced its own
 * resume and the resume won often enough to be the common case. The account of
 * that race, and of the one deadline that replaced it, lives on
 * `DEFAULT_SPEECH_IDLE_TIMEOUT_MS` in `sdk/pipeline-tuning-constants.ts`, which
 * now owns the resume latency outright.
 *
 * So the resume fires on the one signal the transport can actually observe: the
 * transcript stream going quiet with no committed final, which the speaking
 * edge's idle watchdog reports through {@link onUtteranceEnded}. A committed
 * final gets there first through {@link onUserTurn}, so a resume can never run
 * over a real turn.
 *
 * The latch has no self-expiry, which is the one invariant a reader must hold:
 * every path that closes the speaking edge has to consume or clear it. Today
 * that is a committed final (`onUserTurn`), the watchdog (`onUtteranceEnded`),
 * and reset/stop/terminate/cancelReply (`clear`) — a future path that closes
 * the edge through none of them would fire a stale resume on an unrelated later
 * utterance. `pipeline-user-speech.test.ts` pins all three.
 */
export interface FalseInterruptionRecovery {
  /**
   * Latch a resume for the barge-in that just fired. No-op when recovery is
   * disabled or the consecutive-resume budget is spent. `resumePrompt` is what
   * the resume turn is told: a mid-turn barge-in uses the cut-point prompt (or
   * the default continuation prompt when no cut point is known), a
   * playback-tail barge-in embeds the estimated cut point.
   */
  arm(resumePrompt: string): void;
  /** Drop an armed latch, keeping the consecutive-resume budget. */
  clear(): void;
  /**
   * The utterance went quiet without committing a turn (the speaking edge's
   * idle watchdog closed it) — no final is coming, so run the armed resume.
   * No-op when nothing is armed; an armed latch is consumed exactly once.
   */
  onUtteranceEnded(): void;
  /**
   * A real user turn committed (STT final) — the barge-in that preceded it was
   * genuine. Drop the latch and restore the budget.
   */
  onUserTurn(): void;
}

/** Create a {@link FalseInterruptionRecovery}. */
export function createFalseInterruptionRecovery(opts: {
  /** `resumeFalseInterruption`; false disables recovery entirely. */
  enabled: boolean;
  /** Max back-to-back resumes before the user must speak again. */
  maxConsecutive: number;
  /** False once the transport terminated — a released latch then does nothing. */
  isActive: () => boolean;
  /**
   * True while a turn is in flight or client audio may still be playing —
   * something else took the floor, so the interruption resolved itself.
   */
  isBusy: () => boolean;
  /** Run the resume turn with the armed prompt. Only called when active and not busy. */
  onResume: (resumePrompt: string) => void;
}): FalseInterruptionRecovery {
  let consecutive = 0;
  // The prompt a resume owed to a barge-in will run with, or null for "nothing
  // is owed". There is no deadline alongside it — see the interface doc.
  let armed: string | null = null;

  /** Budget guard, shared by arming and releasing. */
  const spent = (): boolean => consecutive >= opts.maxConsecutive;

  return {
    arm(resumePrompt: string): void {
      // Budget spent: persistent cross-talk must not loop barge-in → resume →
      // barge-in indefinitely, each cycle costing a full LLM+TTS turn and
      // another copy of the continuation prompt in history.
      if (!opts.enabled || spent()) return;
      armed = resumePrompt;
    },
    clear(): void {
      armed = null;
    },
    onUtteranceEnded(): void {
      const resumePrompt = armed;
      if (resumePrompt === null) return;
      // Consumed whether or not it runs: a latch the transport declined to
      // spend must not linger into the next utterance.
      armed = null;
      if (!opts.isActive() || opts.isBusy() || spent()) return;
      consecutive++;
      opts.onResume(resumePrompt);
    },
    onUserTurn(): void {
      consecutive = 0;
      armed = null;
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
 * **A MID-TURN barge-in prefers this prompt too**, which is why it is not named
 * for the tail. The `[interrupted]` marker records what the model GENERATED,
 * but the caller only heard as far as the audio actually got — TTS runs behind
 * the text — so "continue from where it was cut off" points at the wrong place
 * and the gap gets re-spoken. Measured: 10% of consecutive agent utterances
 * repeated 60%+ of their words. Quoting the last words the caller actually
 * heard names the real boundary, and `DEFAULT_FALSE_INTERRUPTION_PROMPT` is
 * only the fallback for when no estimate is available (nothing audible yet, or
 * essentially all of it heard), where plain continuation is already correct.
 *
 * That measurement names TTS running behind the text as the CAUSE, and the
 * direct fix for it is that `heardText` is now the same cursor history is
 * truncated with (`pipeline-heard.ts`) rather than a second, independent
 * estimate: the anchor cannot name words the record denies.
 *
 * `heardText` is the reply text the caller is estimated to have heard. Empty
 * means they heard none of it, and the prompt asks for the reply again instead
 * of quoting an empty anchor.
 */
export function buildTailResumePrompt(heardText: string): string {
  const anchorEnd = heardText.length;
  const anchor = heardText.slice(Math.max(0, anchorEnd - TAIL_RESUME_ANCHOR_CHARS)).trim();
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
 * Is a barge-in on this reply worth a resume turn at all?
 *
 * `audioMs` is the reply's forwarded audio and `unheardMs` the part of it the
 * client had not played. Below {@link TAIL_RESUME_MIN_UNHEARD_MS} the caller
 * heard essentially everything and a resume would only append a fragment to a
 * reply that already landed. This is a question about WHETHER a resume is
 * worth running, not about where the cut fell — the cut point comes from the
 * heard cursor in `pipeline-heard.ts`.
 */
export function tailResumeWorthRunning(audioMs: number, unheardMs: number): boolean {
  return audioMs > 0 && unheardMs >= TAIL_RESUME_MIN_UNHEARD_MS;
}
