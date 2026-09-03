// Copyright 2026 the AAI authors. MIT license.
/**
 * A wall-clock budget for one chat turn.
 *
 * The step cap was the only bound on a turn, and it is a poor proxy for how
 * long someone waits: at 80 steps with a 120s per-tool deadline the
 * theoretical worst case is hours. Measured, we saw a 578-second turn and
 * one that passed fifteen minutes. A user watching a spinner cannot tell a
 * working turn from a hung one, so a long turn and a broken one look the
 * same from the outside — and the long one also costs more.
 *
 * Two thresholds rather than one hard kill:
 *
 * - **Soft**: the agent is told, once, to stop starting new work, verify
 *   what it already has, and report honestly. A verified partial agent beats
 *   an unverified complete one, because the user cannot tell them apart and
 *   will publish either.
 * - **Hard**: the loop stops. This exists so a pathological turn ends at a
 *   known time rather than whenever the client gives up — which is what
 *   happened before, and it surfaced as an opaque stream error rather than
 *   an answer.
 *
 * The hard bound is deliberately above the slowest run that SUCCEEDED
 * (578s): the point is to cut off pathology, not to fail work that was
 * nearly done.
 */

/** Tell the agent to wrap up. */
export const SOFT_TURN_MS = 5 * 60_000;

/** Stop the loop regardless. */
export const HARD_TURN_MS = 12 * 60_000;

export type TurnBudget = {
  /**
   * True once the loop must stop — which is one step AFTER the hard deadline,
   * not at it. Stopping cold at the deadline ends the turn wherever the agent
   * happened to be, and if that was a tool call the reply carries no text at
   * all: the user gets a stopped spinner and no account of what happened,
   * which is the failure this whole module exists to prevent. So the deadline
   * buys one final tool-free step (see {@link TurnBudget.takeFinalNotice}) and
   * the loop ends after it.
   */
  expired: () => boolean;
  /**
   * The wrap-up instruction, returned exactly once, else null. Once only
   * because repeating it every step would crowd the context it is trying to
   * save — and an agent told to hurry on every step stops making progress.
   */
  takeWrapUpNotice: () => string | null;
  /**
   * The closing instruction for the one step past the hard deadline, returned
   * exactly once. The caller must run this step with tools disabled, so the
   * turn is guaranteed to end on a message the user can read.
   */
  takeFinalNotice: () => string | null;
  elapsedMs: () => number;
};

export function createTurnBudget(
  now: () => number = Date.now,
  soft = SOFT_TURN_MS,
  hard = HARD_TURN_MS,
): TurnBudget {
  const started = now();
  let warned = false;
  let closing = false;
  const elapsed = () => now() - started;
  /** Both notices open with the same clock reading; one spelling of it. */
  const stamp = () => `[${Math.round(elapsed() / 60_000)} minutes into this turn]`;
  return {
    elapsedMs: elapsed,
    expired: () => closing && elapsed() >= hard,
    takeWrapUpNotice: () => {
      if (warned || elapsed() < soft) return null;
      warned = true;
      return (
        `${stamp()} Wrap up now. ` +
        "Do not start new features or refactors. Finish the change you are on, " +
        "run test_agent once, and reply with what works and what does not. " +
        "A verified partial agent is worth more than an unverified complete one — " +
        "the user cannot tell the difference and will publish either. If something " +
        "is still broken, say so plainly instead of implying it is done."
      );
    },
    takeFinalNotice: () => {
      if (closing || elapsed() < hard) return null;
      closing = true;
      return (
        `${stamp()} Out of time — ` +
        "this is your last message and you cannot call any more tools. Tell the " +
        "user plainly what you built, what you verified, and what is still " +
        "unfinished or broken, so they know where to pick it up. Do not claim " +
        "anything works that you did not test."
      );
    },
  };
}
