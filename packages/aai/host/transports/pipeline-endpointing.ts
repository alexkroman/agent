// Copyright 2026 the AAI authors. MIT license.
// Endpoint settling for the pipeline transport: STT finals buffer here until
// the settle window elapses (or a clearly-complete final arrives), so
// disfluent multi-final utterances (mid-utterance pauses, self-corrections,
// false starts) commit as a single turn instead of the first fragment firing
// a turn and the continuation barging in on it.

import { DEFAULT_COMPLETE_ENDPOINT_CONFIDENCE } from "../../sdk/constants.ts";
import { countWords, utteranceLooksComplete } from "./pipeline-stream.ts";

/** Buffered-utterance endpoint settler. See {@link createEndpointSettler}. */
export interface EndpointSettler {
  /**
   * Buffer an STT final. A clearly-complete utterance (re)arms the short
   * `completeSettleMs` window — hesitant speakers pause at sentence
   * boundaries mid-request, so even a complete-looking final briefly waits
   * for a continuation. A fragment (re)arms the full `settleMs` window. A
   * settle window of 0 commits immediately.
   *
   * Completeness of the boundary: when the STT provider scored it
   * (`endOfTurnConfidence`, e.g. AssemblyAI's `end_of_turn_confidence`),
   * that score decides — the provider's endpointing model reads the
   * boundary better than punctuation. Without a score, the lexical
   * heuristic (terminal punctuation, no trailing continuation cue) applies.
   */
  push(finalText: string, endOfTurnConfidence?: number): void;
  /**
   * Handle an STT partial while an utterance may be buffered. A partial with
   * a buffered utterance means the speaker resumed after a pause: the settle
   * window extends so the continuation aggregates into the same turn instead
   * of the pre-pause fragment committing on its own. Returns true when the
   * partial was consumed this way (the caller should skip barge-in handling).
   */
  extendOnPartial(partialText: string): boolean;
  /** Drop any buffered utterance and cancel its settle timer. */
  reset(): void;
}

/**
 * Create an endpoint settler. `onCommit` receives the aggregated utterance
 * once it commits (never empty text).
 */
export function createEndpointSettler(opts: {
  /** Settle window in ms for fragments; 0 (or negative) commits every final immediately. */
  settleMs: number;
  /**
   * Settle window in ms for clearly-complete finals; 0 (or negative) commits
   * them immediately. Effective window is capped at `settleMs`.
   */
  completeSettleMs: number;
  onCommit: (text: string) => void;
}): EndpointSettler {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Cancel any pending settle timer without dropping the buffered text. */
  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm(ms: number = opts.settleMs): void {
    clearTimer();
    timer = setTimeout(commit, ms);
  }

  /** Commit the buffered utterance as a single turn. */
  function commit(): void {
    clearTimer();
    const text = pending.trim();
    pending = "";
    if (text.length === 0) return;
    opts.onCommit(text);
  }

  return {
    push(finalText: string, endOfTurnConfidence?: number): void {
      pending = pending.length > 0 ? `${pending} ${finalText}` : finalText;
      if (opts.settleMs <= 0) {
        commit();
        return;
      }
      // A clearly-complete utterance gets the short window — enough for an
      // immediate continuation ("...my order. [pause] Oh, and also...") to
      // arrive as a partial and extend, without the full fragment wait. A
      // fragment waits the full settle window for its continuation.
      const complete =
        endOfTurnConfidence !== undefined
          ? endOfTurnConfidence >= DEFAULT_COMPLETE_ENDPOINT_CONFIDENCE
          : utteranceLooksComplete(pending);
      if (complete) {
        const completeMs = Math.min(opts.completeSettleMs, opts.settleMs);
        if (completeMs <= 0) {
          commit();
          return;
        }
        arm(completeMs);
        return;
      }
      arm();
    },
    extendOnPartial(partialText: string): boolean {
      if (timer !== null && pending.length > 0 && countWords(partialText) >= 1) {
        arm();
        return true;
      }
      return false;
    },
    reset(): void {
      clearTimer();
      pending = "";
    },
  };
}
