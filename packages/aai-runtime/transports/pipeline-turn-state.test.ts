// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createTurnMachine } from "./pipeline-turn-state.ts";

describe("createTurnMachine", () => {
  test("initial state: idle, unspoken, gate open (greeting audio must pass)", () => {
    const turns = createTurnMachine();
    expect(turns.inFlight()).toBe(false);
    expect(turns.spoke()).toBe(false);
    expect(turns.audioGateOpen()).toBe(true);
  });

  test("begin → settle round-trips through running", () => {
    const turns = createTurnMachine();
    const ctl = new AbortController();
    turns.begin(ctl);
    expect(turns.inFlight()).toBe(true);
    turns.settle(ctl);
    expect(turns.inFlight()).toBe(false);
    expect(ctl.signal.aborted).toBe(false);
  });

  test("a stale settle does not clear a newer turn", () => {
    const turns = createTurnMachine();
    const oldCtl = new AbortController();
    const newCtl = new AbortController();
    turns.begin(oldCtl);
    turns.begin(newCtl);
    // The old turn's scaffold unwinds late (its finally runs after the
    // replacement began) — the new turn must stay in flight.
    turns.settle(oldCtl);
    expect(turns.inFlight()).toBe(true);
    turns.settle(newCtl);
    expect(turns.inFlight()).toBe(false);
  });

  test("abortCurrent aborts the controller and returns to idle", () => {
    const turns = createTurnMachine();
    const ctl = new AbortController();
    turns.begin(ctl);
    turns.abortCurrent();
    expect(ctl.signal.aborted).toBe(true);
    expect(turns.inFlight()).toBe(false);
    // Idle abort is a no-op.
    turns.abortCurrent();
  });

  test("abort listeners observe the turn still in flight (barge-in reads state synchronously)", () => {
    const turns = createTurnMachine();
    const ctl = new AbortController();
    let inFlightDuringAbort: boolean | null = null;
    ctl.signal.addEventListener("abort", () => {
      inFlightDuringAbort = turns.inFlight();
    });
    turns.begin(ctl);
    turns.abortCurrent();
    expect(inFlightDuringAbort).toBe(true);
  });

  test("begin resets spoke; markSpoke sets it; settle leaves it", () => {
    const turns = createTurnMachine();
    const ctl = new AbortController();
    turns.begin(ctl);
    turns.markSpoke();
    expect(turns.spoke()).toBe(true);
    // spoke survives settle (playback-tail: audio may still be playing
    // client-side after the server-side turn ends).
    turns.settle(ctl);
    expect(turns.spoke()).toBe(true);
    turns.begin(new AbortController());
    expect(turns.spoke()).toBe(false);
  });

  test("interrupt aborts, closes the audio gate, and clears spoke — even when idle", () => {
    const turns = createTurnMachine();
    const ctl = new AbortController();
    turns.begin(ctl);
    turns.markSpoke();
    turns.interrupt();
    expect(ctl.signal.aborted).toBe(true);
    expect(turns.inFlight()).toBe(false);
    expect(turns.spoke()).toBe(false);
    expect(turns.audioGateOpen()).toBe(false);
    // Playback-tail barge-in: no turn in flight, gate must still close.
    turns.openAudioGate();
    turns.markSpoke();
    turns.interrupt();
    expect(turns.audioGateOpen()).toBe(false);
    expect(turns.spoke()).toBe(false);
  });

  test("openAudioGate reopens the gate for the next turn's text", () => {
    const turns = createTurnMachine();
    turns.interrupt();
    expect(turns.audioGateOpen()).toBe(false);
    turns.openAudioGate();
    expect(turns.audioGateOpen()).toBe(true);
  });

  test("draining brackets the drain and is only ever true in flight", () => {
    const turns = createTurnMachine();
    const ctl = new AbortController();
    expect(turns.draining()).toBe(false);

    turns.begin(ctl);
    turns.setDraining(true);
    expect(turns.draining()).toBe(true);
    expect(turns.inFlight()).toBe(true);

    turns.setDraining(false);
    expect(turns.draining()).toBe(false);
  });

  test("a turn that settles mid-drain leaves nothing draining", () => {
    const turns = createTurnMachine();
    const ctl = new AbortController();
    turns.begin(ctl);
    turns.setDraining(true);

    // `runReply` pairs setDraining(false) in a finally, so this is the abort
    // path — where the drain state is discarded rather than closed. It is a
    // substate of `running`, so leaving the turn takes it along: a
    // `draining() && !inFlight()` reading is unrepresentable.
    turns.settle(ctl);

    expect(turns.inFlight()).toBe(false);
    expect(turns.draining()).toBe(false);
  });

  test("a replacement turn does not inherit the previous one's drain", () => {
    const turns = createTurnMachine();
    turns.begin(new AbortController());
    turns.setDraining(true);

    turns.begin(new AbortController());

    expect(turns.inFlight()).toBe(true);
    expect(turns.draining()).toBe(false);
  });

  test("an interrupt mid-drain clears it along with the turn", () => {
    const turns = createTurnMachine();
    const ctl = new AbortController();
    turns.begin(ctl);
    turns.setDraining(true);

    turns.interrupt();

    expect(ctl.signal.aborted).toBe(true);
    expect(turns.draining()).toBe(false);
    expect(turns.inFlight()).toBe(false);
  });

  test("a resume scope with no turn in it is not a resume in flight", () => {
    const turns = createTurnMachine();
    const ctl = new AbortController();

    // The scope brackets the whole chained call, so it opens before `begin`
    // and closes after `settle` — the two moments this predicate exists for.
    turns.setResumeScope(true);
    expect(turns.resumeInFlight()).toBe(false);

    turns.begin(ctl);
    expect(turns.resumeInFlight()).toBe(true);

    turns.settle(ctl);
    expect(turns.resumeInFlight()).toBe(false);

    turns.setResumeScope(false);
    expect(turns.resumeInFlight()).toBe(false);
  });

  test("an ordinary turn inside no resume scope is not a resume", () => {
    const turns = createTurnMachine();
    turns.begin(new AbortController());
    expect(turns.resumeInFlight()).toBe(false);
  });
});
