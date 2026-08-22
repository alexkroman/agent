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
    turn.onAck("flush_done");
    expect(doneCount()).toBe(0);

    turn.onFlushSent(); // end-of-turn flush
    turn.closeTurn();
    expect(doneCount()).toBe(0);
    turn.onAck("flush_done");
    expect(doneCount()).toBe(1);
  });

  test("closeTurn with everything already acknowledged ends the turn immediately", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent();
    turn.onAck("flush_done");
    turn.closeTurn();
    expect(doneCount()).toBe(1);
  });

  test("an is_final and its FlushDone count as one acknowledgement", () => {
    // A server may signal the same synthesis's completion both ways. Counting
    // the pair twice reads the surplus FlushDone as unsolicited and ends the
    // turn while later segments are still synthesizing — the reply is cut off
    // before the voice finishes.
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent(); // segment 1
    turn.onAck("is_final");
    turn.onAck("flush_done"); // same flush, acked again
    expect(doneCount()).toBe(0);

    turn.onFlushSent(); // final segment
    turn.closeTurn();
    turn.onAck("is_final");
    expect(doneCount()).toBe(1); // exactly once, on the LAST flush's ack
    turn.onAck("flush_done");
    expect(doneCount()).toBe(1);
  });

  test("a FlushDone-only server is unaffected by the pairing", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent();
    turn.onAck("flush_done");
    turn.onFlushSent();
    turn.closeTurn();
    turn.onAck("flush_done");
    expect(doneCount()).toBe(1);
  });

  test("an is_final-only server still ends the turn per acknowledgement", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent();
    turn.onAck("is_final");
    turn.onFlushSent();
    turn.closeTurn();
    turn.onAck("is_final");
    expect(doneCount()).toBe(1);
  });

  test("a truly unsolicited acknowledgement ends the turn, as always", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText(); // turn open, nothing flushed yet
    turn.onAck("flush_done");
    expect(doneCount()).toBe(1);
  });

  test("cancel abandons outstanding flushes, ends the turn, and reports in-flight", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent();
    expect(turn.cancel()).toBe(true);
    expect(doneCount()).toBe(1);
    expect(turn.cancel()).toBe(false); // idempotent — no turn in flight

    // Nothing from the cancelled turn (its abandoned flush, its debt) may
    // leak into the next one.
    turn.onTurnText();
    turn.onFlushSent();
    turn.closeTurn();
    turn.onAck("flush_done");
    expect(doneCount()).toBe(2);
  });

  test("a FlushDone delayed past the turn boundary cannot retire the next turn's flush", () => {
    // The previous turn's last synthesis was acknowledged by its `is_final` —
    // ending that turn — while the paired `FlushDone` was still on the wire.
    // The debt must survive `onTurnText`, or the stale frame frees a flush of
    // the NEXT turn and `done` overtakes its still-streaming audio.
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent();
    turn.closeTurn();
    turn.onAck("is_final"); // ends turn A; its FlushDone is still in flight
    expect(doneCount()).toBe(1);

    turn.onTurnText(); // turn B starts before the stale frame lands
    turn.onFlushSent();
    turn.onAck("flush_done"); // turn A's late FlushDone — pairs with the debt
    turn.closeTurn();
    expect(doneCount()).toBe(1); // B still waiting on its own ack

    turn.onAck("flush_done"); // B's real acknowledgement
    expect(doneCount()).toBe(2);
  });

  test("a stale FlushDone landing between turns is absorbed by the pairing debt", () => {
    const { turn, doneCount } = tracker();
    turn.onTurnText();
    turn.onFlushSent();
    turn.closeTurn();
    turn.onAck("is_final");
    expect(doneCount()).toBe(1);

    turn.onAck("flush_done"); // late pair partner, no turn open — a no-op
    turn.onTurnText();
    turn.onFlushSent();
    turn.closeTurn();
    turn.onAck("flush_done");
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
});
