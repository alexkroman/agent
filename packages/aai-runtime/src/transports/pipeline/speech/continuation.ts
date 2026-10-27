// Copyright 2026 the AAI authors. MIT license.
/**
 * Is this utterance the REST of the turn that just committed?
 *
 * Endpointing commits on a pause, so a caller who pauses mid-sentence is split
 * into two turns, and turns run strictly in sequence: the reply to the first
 * fragment plays in full before the second is answered. The barge-in rules
 * cannot catch it, because the resumed speech began before the agent had
 * spoken — `utteranceOpenedOverSpeech` is false — so it never takes the floor.
 *
 * The decision keys on the utterance's OPENING, not on its final: the second
 * fragment's final lands a median 5.0s after the first (the caller finishes
 * the sentence, then endpointing waits again), by which time the reply to half
 * a sentence is long since on the line. Resumed speech is visible a median
 * 1.95s after the commit. See `DEFAULT_CONTINUATION_WINDOW_MS`.
 *
 * Pure bookkeeping: the caller decides what "abort" means. It fires at most
 * once per utterance, and only for an utterance that opened within the window
 * after the most recent commit — a later commit restarts the window.
 *
 * **Capped, because every fire restarts a reply.** The barge-in rules refuse to
 * abort a reply that has not spoken for exactly this reason: a caller who keeps
 * re-prompting into the silence ("hello? any update?") would otherwise starve
 * the reply, every restart outliving the next re-prompt. A continuation is that
 * abort, so at most {@link MAX_CONTINUATIONS} may fire within
 * {@link CONTINUATION_BURST_MS}; past that, fragments chain the old way and the
 * loop cannot form.
 */

/** Continuations allowed within one {@link CONTINUATION_BURST_MS}. */
export const MAX_CONTINUATIONS = 2;
/** The window the {@link MAX_CONTINUATIONS} cap is counted over, in ms. */
export const CONTINUATION_BURST_MS = 10_000;

/** See {@link createContinuationGate}. */
export interface ContinuationGate {
  /** A user turn committed now. */
  onCommit(): void;
  /**
   * Does the utterance that opened at `openedAtMs` continue the last committed
   * turn? True at most once per utterance; the caller acts on it.
   */
  continues(openedAtMs: number): boolean;
}

export function createContinuationGate(deps: {
  /** The window, per dialog state — `0` disables. */
  windowMs: () => number;
  /** Clock, injectable for tests. */
  now?: () => number;
}): ContinuationGate {
  const now = deps.now ?? Date.now;
  let lastCommitAt: number | undefined;
  /** The opening of the utterance this already fired for, if any. */
  let firedFor: number | undefined;
  /** When recent continuations fired, for the burst cap. */
  let fires: number[] = [];
  return {
    onCommit(): void {
      lastCommitAt = now();
      firedFor = undefined;
    },
    continues(openedAtMs: number): boolean {
      const windowMs = deps.windowMs();
      if (windowMs <= 0 || lastCommitAt === undefined) return false;
      if (firedFor === openedAtMs) return false;
      const sinceCommit = openedAtMs - lastCommitAt;
      // Opened BEFORE the commit means this utterance is the one that
      // committed (its edge stays open through the final), not a new one.
      if (sinceCommit < 0 || sinceCommit > windowMs) return false;
      const t = now();
      fires = fires.filter((at) => t - at < CONTINUATION_BURST_MS);
      if (fires.length >= MAX_CONTINUATIONS) return false;
      fires.push(t);
      firedFor = openedAtMs;
      return true;
    },
  };
}
