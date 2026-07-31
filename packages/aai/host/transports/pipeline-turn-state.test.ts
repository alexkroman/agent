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
});
