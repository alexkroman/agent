// Copyright 2026 the AAI authors. MIT license.
/**
 * Caller turns that queue up behind a slow reply are answered ONCE.
 *
 * A committed caller turn is chained behind the reply in flight
 * (`TurnChain.chain`), and a reply that has not spoken cannot be barged in on
 * — so a caller re-prompting into a stalled reply ("hello?", "are you
 * there?") queues one turn per utterance. Each used to run as its own model
 * turn when the line came back. Measured on a tau2-bench voice run with a
 * rate-limited LLM: six replies in about two seconds on one session, each
 * answering one fragment of what the caller had said while waiting.
 *
 * So a caller turn committed while an EARLIER caller turn is still waiting to
 * start joins it instead: the waiting turn, when it runs, answers every
 * utterance it gathered as one user message. Only a turn that has not
 * started can gather — once it is running, its user message is in history and
 * the next commit queues a turn of its own, as before.
 *
 * Three things stop a waiting turn from gathering, each because joining would
 * reorder or lose what the caller said:
 *
 * - **It started** (`take`).
 * - **A non-caller turn was queued after it** (`seal`) — a silence nudge, a
 *   resume, an injected prompt. A later utterance belongs after that turn.
 * - **The queue epoch moved** — a `cancelReply`/`reset`/`stop` will strand it,
 *   and text joined to a stranded turn would never be answered.
 */

/** One caller turn waiting on the chain, and what it has gathered. */
export type WaitingCallerTurn = {
  /**
   * Claim the gathered utterances as the turn starts, ending the gathering.
   * Answers the user message to send, every joined utterance in commit order,
   * and the model-only note, if any utterance carried one.
   *
   * `utterances` is what the turn's STT marks are claimed by
   * (`TurnMetrics.claimTurn`), EACH of them in order, so the last claim — the
   * newest utterance — is the one reported. Claiming only the last TEXT is
   * wrong for repeats ("hello?", "hello?"): `claimTurn` takes the OLDEST
   * pending mark with that text, reporting the first utterance's timing and
   * leaving the second's for a later "hello?" turn to take.
   */
  take(): { text: string; utterances: readonly string[]; note: string | undefined };
};

/** See the module doc. */
export type CallerTurnQueue = {
  /**
   * Add a committed caller utterance. Answers `undefined` when it joined a
   * waiting turn (nothing to chain), or the new waiting turn to chain.
   */
  commit(text: string, note: string | undefined): WaitingCallerTurn | undefined;
  /** A non-caller turn was queued: nothing waiting may gather past it. */
  seal(): void;
};

/** Create a {@link CallerTurnQueue} over the turn gate's queue epoch. */
export function createCallerTurnQueue(deps: {
  queueEpoch(): number;
  queueCurrent(epoch: number): boolean;
}): CallerTurnQueue {
  let waiting: { texts: string[]; notes: string[]; epoch: number } | undefined;
  return {
    commit(text, note) {
      if (waiting !== undefined && deps.queueCurrent(waiting.epoch)) {
        waiting.texts.push(text);
        if (note !== undefined) waiting.notes.push(note);
        return;
      }
      const entry = {
        texts: [text],
        notes: note === undefined ? [] : [note],
        epoch: deps.queueEpoch(),
      };
      waiting = entry;
      return {
        take() {
          if (waiting === entry) waiting = undefined;
          return {
            text: entry.texts.join(" "),
            utterances: entry.texts,
            note: entry.notes.length === 0 ? undefined : entry.notes.join("\n\n"),
          };
        },
      };
    },
    seal() {
      waiting = undefined;
    },
  };
}
