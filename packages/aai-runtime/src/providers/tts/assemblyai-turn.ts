// Copyright 2026 the AAI authors. MIT license.
/**
 * Turn-acknowledgement accounting for the AssemblyAI streaming TTS adapter.
 *
 * The adapter flushes per segment, so one turn spans several `Flush` frames
 * and the turn ends only when the LAST one is acknowledged — see the module
 * doc in `assemblyai.ts`. This module owns that bookkeeping: how many flushes
 * are outstanding, and whether the pipeline has closed the turn. Each `Flush`
 * is answered by exactly one `FlushDone`, in order
 * (https://www.assemblyai.com/docs/tts/message-frames), so a count is enough.
 */

/** Per-turn flush/acknowledgement state machine. */
export interface TurnTracker {
  /**
   * Text arrived for a turn. If the previous turn already finished, reset all
   * per-turn state — nothing from the last turn carries over — and return
   * `true`: a new turn began, and it now owns the word timeline (see
   * {@link TurnTracker.wordsOpen}).
   */
  onTurnText(): boolean;
  /** A `Generate`+`Flush` pair went out for this turn. */
  onFlushSent(): void;
  /**
   * A `FlushDone` arrived: retire one outstanding flush, emitting `done` when
   * it was the last one of a closed turn. One with nothing outstanding belongs
   * to no flush this turn sent and is ignored.
   */
  onAck(): void;
  /**
   * The pipeline has no more text for this turn: the last outstanding
   * acknowledgement ends it — or, when every segment was already
   * acknowledged, it ends right here.
   */
  closeTurn(): void;
  /**
   * Barge-in. Abandons the turn's outstanding flushes (their acks will never
   * arrive — the socket is dropped or the queued frames discarded) and emits
   * `done` synchronously. Returns whether a turn was actually in flight; when
   * none was, it changes nothing but the word window, which a cancel closes
   * either way.
   */
  cancel(): boolean;
  /**
   * The socket carrying this turn's flushes was replaced: their
   * acknowledgements will never arrive. Forget them, keeping the turn open —
   * an already-closed turn ends here, an open one when it closes.
   */
  abandonFlushes(): void;
  /** Unexpected server-side close: release the turn unconditionally. */
  forceDone(): void;
  /**
   * Is a turn still open (text arrived, `done` not yet emitted)? The same fact
   * {@link cancel} returns, exposed as a query so the adapter can DROP a frame
   * that arrives once the turn is over — a late `WordBoundaries` would
   * otherwise be attributed to the next reply.
   */
  inFlight(): boolean;
  /**
   * Does a turn own the word timeline? False before the first turn, and from
   * a cancel until the next turn's first text. Unlike {@link inFlight} it stays
   * true past a turn's normal `done`: a `WordBoundaries` frame may TRAIL its
   * own flush's `FlushDone` (`assemblyai.ts` has the measurement), so the only
   * window that closes is the one a cancel closes.
   */
  wordsOpen(): boolean;
}

/**
 * Create a {@link TurnTracker}. `emitDone` fires at most once per turn; the
 * caller guards it against a closed session and clears its own buffered text
 * (the turn is over, so text still held belongs to nothing).
 */
export function createTurnTracker(emitDone: () => void): TurnTracker {
  let doneEmitted = true; // no turn in flight until the first onTurnText
  // Flushes awaiting acknowledgement. The server answers in order on one
  // socket, so a count is enough to know when the turn's audio is complete.
  let outstandingFlushes = 0;
  // `closeTurn()` ran for the current turn: the pipeline has no more text.
  let turnClosed = false;
  // A turn owns the word timeline — see `wordsOpen()`.
  let wordsOpen = false;

  const emitDoneOnce = (): void => {
    if (doneEmitted) return;
    doneEmitted = true;
    emitDone();
  };

  return {
    onTurnText(): boolean {
      if (!doneEmitted) return false;
      doneEmitted = false;
      wordsOpen = true;
      turnClosed = false;
      outstandingFlushes = 0;
      return true;
    },

    onFlushSent(): void {
      outstandingFlushes += 1;
    },

    onAck(): void {
      if (outstandingFlushes === 0) return;
      outstandingFlushes -= 1;
      if (outstandingFlushes === 0 && turnClosed) emitDoneOnce();
    },

    closeTurn(): void {
      turnClosed = true;
      if (outstandingFlushes === 0) emitDoneOnce();
    },

    cancel(): boolean {
      // First, and whether or not a turn is in flight. The cancel window
      // filters the abandoned turn's frames only until `Cancelled`, and `done`
      // is emitted for it below, so this is what stops a trailing frame
      // landing on a reply the client has dropped.
      wordsOpen = false;
      if (doneEmitted) return false;
      outstandingFlushes = 0;
      turnClosed = false;
      emitDoneOnce();
      return true;
    },

    abandonFlushes(): void {
      outstandingFlushes = 0;
      if (turnClosed) emitDoneOnce();
    },

    forceDone: emitDoneOnce,

    inFlight(): boolean {
      return !doneEmitted;
    },

    wordsOpen: () => wordsOpen,
  };
}
