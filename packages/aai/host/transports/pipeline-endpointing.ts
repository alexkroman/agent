// Copyright 2026 the AAI authors. MIT license.
// Endpoint settling for the pipeline transport: STT finals buffer here until
// the settle window elapses (or a clearly-complete final arrives), so
// disfluent multi-final utterances (mid-utterance pauses, self-corrections,
// false starts) commit as a single turn instead of the first fragment firing
// a turn and the continuation barging in on it.

import { countWords, utteranceLooksComplete } from "./pipeline-stream.ts";

/** Buffered-utterance endpoint settler. See {@link createEndpointSettler}. */
export interface EndpointSettler {
  /**
   * Buffer an STT final. A clearly-complete utterance (terminal punctuation,
   * no trailing continuation cue) — or a settle window of 0 — commits
   * immediately so clean requests pay no settle latency; a fragment (re)arms
   * the settle timer to wait for continuation.
   */
  push(finalText: string): void;
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
  /** Settle window in ms; 0 (or negative) commits every final immediately. */
  settleMs: number;
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

  function arm(): void {
    clearTimer();
    timer = setTimeout(commit, opts.settleMs);
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
    push(finalText: string): void {
      pending = pending.length > 0 ? `${pending} ${finalText}` : finalText;
      // Fast path: a clearly-complete utterance commits immediately so clean
      // requests pay no settle latency (and multi-tool chains have more of the
      // response window). A fragment waits the settle window for continuation.
      if (opts.settleMs <= 0 || utteranceLooksComplete(pending)) {
        commit();
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
