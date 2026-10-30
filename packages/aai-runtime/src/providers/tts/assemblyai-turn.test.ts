// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createTurnTracker, type TurnTracker } from "./assemblyai-turn.ts";

function tracker(): { turn: TurnTracker; doneCount: () => number } {
  let done = 0;
  const turn = createTurnTracker(() => {
    done += 1;
  });
  return { turn, doneCount: () => done };
}

describe("createTurnTracker", () => {
  test("the turn ends on the last outstanding acknowledgement after closeTurn", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent(); // segment
    turn.onAck();
    expect(doneCount()).toBe(0);

    turn.onFlushSent(); // end-of-turn flush
    turn.closeTurn();
    expect(doneCount()).toBe(0);
    turn.onAck();
    expect(doneCount()).toBe(1);
  });

  test("closeTurn with everything already acknowledged ends the turn immediately", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent();
    turn.onAck();
    turn.closeTurn();
    expect(doneCount()).toBe(1);
  });

  test("an acknowledgement with nothing outstanding is ignored", () => {
    // It belongs to no flush this turn sent: ending the turn on it would cut
    // the reply off before its own audio arrived.
    const { turn, doneCount } = tracker();
    turn.onTurnText(); // turn open, nothing flushed yet
    turn.onAck();
    expect(doneCount()).toBe(0);
    turn.onFlushSent();
    turn.closeTurn();
    turn.onAck();
    expect(doneCount()).toBe(1);
  });

  test("cancel abandons outstanding flushes, ends the turn, and reports in-flight", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent();
    expect(turn.cancel()).toBe(true);
    expect(doneCount()).toBe(1);
    expect(turn.cancel()).toBe(false); // idempotent — no turn in flight

    // Nothing from the cancelled turn (its abandoned flush) may
    // leak into the next one.
    turn.onTurnText();
    turn.onFlushSent();
    turn.closeTurn();
    turn.onAck();
    expect(doneCount()).toBe(2);
  });

  test("abandonFlushes ends a closed turn, and leaves an open one to its closeTurn", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent();
    turn.closeTurn();
    turn.abandonFlushes(); // the socket owing that ack was dropped
    expect(doneCount()).toBe(1);

    turn.onTurnText();
    turn.onFlushSent();
    turn.abandonFlushes();
    expect(doneCount()).toBe(1); // still open: more text may come
    turn.closeTurn();
    expect(doneCount()).toBe(2);
  });

  test("forceDone releases the turn unconditionally, once", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent();
    turn.forceDone();
    turn.forceDone();
    expect(doneCount()).toBe(1);
  });

  test("onTurnText says when it began a new turn", () => {
    const { turn } = tracker();
    expect(turn.onTurnText()).toBe(true);
    expect(turn.onTurnText()).toBe(false); // same turn
    turn.closeTurn();
    expect(turn.onTurnText()).toBe(true);
  });

  test("the word window opens with a turn, outlives its done, and closes on cancel", () => {
    const { turn } = tracker();
    expect(turn.wordsOpen()).toBe(false); // before the first turn
    turn.onTurnText();
    expect(turn.wordsOpen()).toBe(true);
    turn.closeTurn(); // done: a trailing WordBoundaries still belongs to it
    expect(turn.inFlight()).toBe(false);
    expect(turn.wordsOpen()).toBe(true);
    expect(turn.cancel()).toBe(false); // nothing in flight, but still closes it
    expect(turn.wordsOpen()).toBe(false);
    turn.onTurnText();
    turn.cancel();
    expect(turn.wordsOpen()).toBe(false);
  });
});

describe("reopenForResend", () => {
  test("reopens a closed turn instead of ending it, and reports that it was closed", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent();
    turn.closeTurn();
    expect(turn.reopenForResend()).toBe(true);
    expect(doneCount()).toBe(0);
    // The re-sent flush, then the close the adapter re-issues.
    turn.onFlushSent();
    turn.closeTurn();
    turn.onAck();
    expect(doneCount()).toBe(1);
  });

  test("an open turn stays open; no turn in flight is left alone", () => {
    const { turn, doneCount } = tracker();
    expect(turn.reopenForResend()).toBe(false);
    turn.onTurnText();
    turn.onFlushSent();
    expect(turn.reopenForResend()).toBe(false);
    turn.closeTurn(); // the dropped flush no longer counts
    expect(doneCount()).toBe(1);
  });
});
