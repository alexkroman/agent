// Copyright 2026 the AAI authors. MIT license.
/**
 * The cap on ONE user turn — `AgentDef.userTurnLimit`, applied.
 *
 * End-of-turn is the STT provider's decision and it is driven by silence, so
 * a caller who never pauses never ends a turn: the agent cannot answer,
 * redirect or hand off until they stop. This module is the bound on that. It
 * watches the open utterance — the words in each interim transcript and the
 * time since the speaking edge opened — and when either crosses its cap it
 * fires `onExceeded` ONCE for that utterance. The transport answers by
 * reporting `user-turn.exceeded` and asking the transcriber to end the turn
 * now, so the words heard so far commit on the ordinary final path and speech
 * after the cut opens the provider's next turn.
 *
 * ## Why the cut is the PROVIDER's and not this module's
 *
 * A host-side cut would have to commit an interim transcript and then
 * reconcile it against the final the provider still owes for the same
 * utterance — a final that may revise words already committed, that arrives
 * on no schedule this process can see, and that would otherwise commit the
 * whole utterance a second time. `SttSession.forceEndOfTurn` sidesteps all of
 * it: the provider ends the turn exactly as a pause would have, and nothing
 * downstream can tell the two apart. The price is that a provider without the
 * capability cannot honour the cap, which the transport logs once per session
 * rather than silently — the treatment `updateEndpointing` already gets.
 *
 * ## Its lifecycle IS the speaking edge's
 *
 * Armed when the edge opens, cleared when it closes, and the once-per-utterance
 * latch resets with it — through the tracker's own callbacks, so every path
 * that closes an edge (a committed final, the idle watchdog, a session reset)
 * clears this without naming it. A limiter with a lifecycle of its own would be
 * one more thing every teardown path has to remember, and `pipeline-recovery.ts`
 * records what forgetting one costs.
 */

import type { UserTurnLimit } from "@alexkroman1/aai";
import { createRestartableTimer } from "../_timer.ts";
import { scanWords } from "./pipeline-text.ts";

/** Which cap an utterance crossed — the `limit` field of `user-turn.exceeded`. */
export type UserTurnLimitKind = "words" | "duration";

/** The cap on one user turn, bound to a session — see {@link createUserTurnLimiter}. */
export interface UserTurnLimiter {
  /**
   * The word ceiling the partial handler's bounded scan must count up to, so
   * a partial is never scanned past what any consumer thresholds on. `0` when
   * no word cap is declared.
   */
  readonly maxWords: number;
  /** The speaking edge opened: arm the duration deadline, if there is one. */
  onUtteranceStarted(): void;
  /**
   * An interim transcript arrived for the open utterance, with its word count
   * (bounded by {@link maxWords}, so `>=` is the only honest comparison).
   */
  onPartial(text: string, words: number): void;
  /** The speaking edge closed: clear the deadline and the once-per-utterance latch. */
  onUtteranceEnded(): void;
}

/** A session with no cap — the shipped default, and a no-op throughout. */
export const NO_USER_TURN_LIMIT: UserTurnLimiter = {
  maxWords: 0,
  onUtteranceStarted: () => undefined,
  onPartial: () => undefined,
  onUtteranceEnded: () => undefined,
};

/**
 * Bind `userTurnLimit` to one session.
 *
 * A session that declared none gets {@link NO_USER_TURN_LIMIT} itself, so the
 * partial handler's hot path — one call per interim, several a second while
 * the caller talks — pays a no-op call and nothing else. `durationMs` is the
 * speaking-edge tracker's own clock, read at the moment the cap fires rather
 * than kept here, so the event reports the same duration the barge-in gate
 * would have.
 */
export function createUserTurnLimiter(
  limit: UserTurnLimit | undefined,
  deps: {
    /** Ms since the open utterance's first word — `SpeechEdgeTracker.durationMs`. */
    durationMs: () => number;
    /** The cap fired. Once per utterance; the transport reports and cuts. */
    onExceeded(limit: UserTurnLimitKind, words: number, durationMs: number): void;
  },
): UserTurnLimiter {
  const maxWords = limit?.maxWords ?? 0;
  const maxDurationMs = limit?.maxDurationMs ?? 0;
  if (!(maxWords > 0 || maxDurationMs > 0)) return NO_USER_TURN_LIMIT;
  // Once per utterance: the provider's final follows a forced end within its
  // own emission latency, and partials keep arriving until it does — every
  // one of them still over the cap. Without the latch each would fire again.
  let fired = false;
  let lastText = "";
  const fire = (kind: UserTurnLimitKind, words: number): void => {
    if (fired) return;
    fired = true;
    deps.onExceeded(kind, words, deps.durationMs());
  };
  // One-shot rather than restartable in spirit: armed at the edge's open and
  // never re-armed until it closes, so continued speech cannot push it out
  // the way it restarts the idle watchdog. `createRestartableTimer` is still
  // the right primitive — `arm` is only ever called once per utterance, and
  // `clear` is what `onUtteranceEnded` needs.
  const deadline = createRestartableTimer(() => {
    // An exact count for the record: the partial scan was bounded, and this
    // runs once per utterance at most, so the full walk is affordable here.
    fire("duration", scanWords(lastText, Number.POSITIVE_INFINITY));
  });
  return {
    maxWords,
    onUtteranceStarted(): void {
      fired = false;
      lastText = "";
      deadline.arm(maxDurationMs);
    },
    onPartial(text: string, words: number): void {
      lastText = text;
      if (maxWords > 0 && words >= maxWords) fire("words", words);
    },
    onUtteranceEnded(): void {
      deadline.clear();
      fired = false;
      lastText = "";
    },
  };
}
