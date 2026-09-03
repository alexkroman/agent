// Copyright 2026 the AAI authors. MIT license.
/**
 * Turn-acknowledgement accounting for the AssemblyAI streaming TTS adapter.
 *
 * The adapter flushes per segment, so one turn spans several `Flush` frames
 * and the turn ends only when the LAST one is acknowledged — see the module
 * doc in `assemblyai.ts`. This module owns that bookkeeping: how many flushes
 * are outstanding, whether the pipeline has closed the turn, and the one
 * wrinkle that makes counting non-trivial — a server may acknowledge the SAME
 * synthesis twice, as an `Audio` frame flagged `is_final` and then that
 * flush's `FlushDone`. The pair must count as ONE acknowledgement:
 * double-counting frees the turn while later segments are still synthesizing,
 * so `done` — and with it the client's `audio_done` — overtakes their audio
 * and the reply is audibly cut off before the voice finishes (any text still
 * buffered for the turn is dropped with it). The socket answers in order, so
 * an `is_final` always precedes its own `FlushDone`; `flushDoneDebt` pairs
 * them.
 */

/** Which frame acknowledged a synthesis — see {@link TurnTracker.onAck}. */
export type SynthesisAck = "is_final" | "flush_done";

/** Per-turn flush/acknowledgement state machine. */
export interface TurnTracker {
  /**
   * Text arrived for a turn. If the previous turn already finished, reset all
   * per-turn state — nothing from the last turn carries over.
   */
  onTurnText(): void;
  /** A `Generate`+`Flush` pair went out for this turn. */
  onFlushSent(): void;
  /**
   * A completion frame arrived. Dedups the `is_final`+`FlushDone` pair (see
   * the module doc), then either retires one outstanding flush — emitting
   * `done` when it was the last one of a closed turn — or, with nothing
   * pending, treats the ack as the turn ending (a server that flags frames
   * rather than sending FlushDone, or a stray ack), as this adapter always
   * has.
   */
  onAck(ack: SynthesisAck): void;
  /**
   * The pipeline has no more text for this turn: the last outstanding
   * acknowledgement ends it — or, when every segment was already
   * acknowledged, it ends right here.
   */
  closeTurn(): void;
  /**
   * Barge-in. Abandons the turn's outstanding flushes (their acks will never
   * arrive — the socket is dropped or the queued frames discarded) and emits
   * `done` synchronously. Returns whether a turn was actually in flight.
   */
  cancel(): boolean;
  /** Unexpected server-side close: release the turn unconditionally. */
  forceDone(): void;
  /**
   * Is a turn still open (text arrived, `done` not yet emitted)? The same fact
   * {@link cancel} returns, exposed as a query so the adapter can DROP a frame
   * that arrives once the turn is over — a late `WordBoundaries` would
   * otherwise be attributed to the next reply.
   */
  inFlight(): boolean;
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
  // FlushDone frames already accounted for by an `is_final` Audio frame.
  let flushDoneDebt = 0;

  const emitDoneOnce = (): void => {
    if (doneEmitted) return;
    doneEmitted = true;
    emitDone();
  };

  return {
    onTurnText(): void {
      if (!doneEmitted) return;
      doneEmitted = false;
      turnClosed = false;
      outstandingFlushes = 0;
      // `flushDoneDebt` deliberately survives the turn boundary: it pairs
      // per-SOCKET frames, not per-turn state. The previous turn's last
      // synthesis may have been acknowledged by its `is_final` — ending that
      // turn — while the paired `FlushDone` is still on the wire. Zeroing the
      // debt here would let that stale frame retire one of THIS turn's
      // outstanding flushes, emitting `done` while its audio is still
      // streaming. The debt resets only in `cancel()`, where the socket is
      // actually swapped (or its queued frames discarded).
    },

    onFlushSent(): void {
      outstandingFlushes += 1;
    },

    onAck(ack: SynthesisAck): void {
      if (ack === "flush_done" && flushDoneDebt > 0) {
        flushDoneDebt -= 1;
        return;
      }
      if (ack === "is_final") flushDoneDebt += 1;
      if (outstandingFlushes === 0) {
        emitDoneOnce();
        return;
      }
      outstandingFlushes -= 1;
      if (outstandingFlushes === 0 && turnClosed) emitDoneOnce();
    },

    closeTurn(): void {
      turnClosed = true;
      if (outstandingFlushes === 0) emitDoneOnce();
    },

    cancel(): boolean {
      const turnInFlight = !doneEmitted;
      outstandingFlushes = 0;
      flushDoneDebt = 0;
      turnClosed = false;
      emitDoneOnce();
      return turnInFlight;
    },

    forceDone: emitDoneOnce,

    inFlight(): boolean {
      return !doneEmitted;
    },
  };
}
