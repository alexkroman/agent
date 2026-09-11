// Copyright 2026 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { silentLogger } from "../_test-utils.ts";
import { createSpeakGate } from "./pipeline-speak-gate.ts";

const GATE = { log: silentLogger, sid: "t" };

describe("both windows at 0", () => {
  test("is a PASS-THROUGH, not a zero-length wait — no timer, no queue", () => {
    const gate = createSpeakGate({
      startSpeakingFloorMs: 0,
      interruptionBackoffMs: 0,
      ...GATE,
    });
    const delivered: number[] = [];
    gate.hold(1000); // ignored: this gate holds nothing
    gate.deliver(() => delivered.push(1));
    gate.deliver(() => delivered.push(2));
    expect(delivered).toEqual([1, 2]);
  });
});

describe("the floor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const gateWith = (floorMs: number, backoffMs = 0) =>
    createSpeakGate({
      startSpeakingFloorMs: floorMs,
      interruptionBackoffMs: backoffMs,
      ...GATE,
    });

  test("holds output until the deadline, then flushes in arrival order", () => {
    const gate = gateWith(400);
    const delivered: number[] = [];
    gate.hold(400);
    gate.deliver(() => delivered.push(1));
    gate.deliver(() => delivered.push(2));
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(399);
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(delivered).toEqual([1, 2]);
  });

  test("a pipeline slower than the floor pays nothing", () => {
    const gate = gateWith(400);
    const delivered: number[] = [];
    gate.hold(400);
    vi.advanceTimersByTime(400);
    gate.deliver(() => delivered.push(1));
    expect(delivered).toEqual([1]);
  });

  test("once the deadline passes the gate is transparent again", () => {
    const gate = gateWith(400);
    const delivered: number[] = [];
    gate.hold(400);
    gate.deliver(() => delivered.push(1));
    vi.advanceTimersByTime(400);
    gate.deliver(() => delivered.push(2));
    gate.deliver(() => delivered.push(3));
    expect(delivered).toEqual([1, 2, 3]);
  });

  test("a non-positive hold is a no-op", () => {
    const gate = gateWith(400);
    const delivered: number[] = [];
    gate.hold(0);
    gate.deliver(() => delivered.push(1));
    expect(delivered).toEqual([1]);
  });
});

describe("the backoff, and the two together", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the windows are SEQUENTIAL, never cumulative: the deadline is the later one", () => {
    const gate = createSpeakGate({
      startSpeakingFloorMs: 400,
      interruptionBackoffMs: 1000,
      ...GATE,
    });
    const delivered: number[] = [];
    gate.hold(1000); // a real interruption
    vi.advanceTimersByTime(200);
    gate.hold(400); // the reply that follows arms its own floor
    gate.deliver(() => delivered.push(1));
    // Cumulative would be 1400ms from the interruption; sequential is 1000.
    vi.advanceTimersByTime(799);
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(delivered).toEqual([1]);
  });

  test("a hold that would END LATER does extend the deadline", () => {
    const gate = createSpeakGate({
      startSpeakingFloorMs: 400,
      interruptionBackoffMs: 1000,
      ...GATE,
    });
    const delivered: number[] = [];
    gate.hold(400);
    vi.advanceTimersByTime(200);
    gate.hold(1000);
    gate.deliver(() => delivered.push(1));
    vi.advanceTimersByTime(200); // the original floor would have fired here
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(800);
    expect(delivered).toEqual([1]);
  });
});

describe("dropping and stopping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("drop() discards what is queued — a cancelled turn's audio is not wanted late", () => {
    const gate = createSpeakGate({
      startSpeakingFloorMs: 400,
      interruptionBackoffMs: 0,
      ...GATE,
    });
    const delivered: number[] = [];
    gate.hold(400);
    gate.deliver(() => delivered.push(1));
    gate.drop();
    vi.advanceTimersByTime(400);
    expect(delivered).toEqual([]);
  });

  test("a delivery after a drop still works — the gate is not poisoned", () => {
    const gate = createSpeakGate({
      startSpeakingFloorMs: 400,
      interruptionBackoffMs: 0,
      ...GATE,
    });
    const delivered: number[] = [];
    gate.hold(400);
    gate.deliver(() => delivered.push(1));
    gate.drop();
    gate.deliver(() => delivered.push(2));
    vi.advanceTimersByTime(400);
    expect(delivered).toEqual([2]);
  });

  test("stop() clears the timer so a pending flush cannot fire into a dead session", () => {
    const gate = createSpeakGate({
      startSpeakingFloorMs: 400,
      interruptionBackoffMs: 0,
      ...GATE,
    });
    const delivered: number[] = [];
    gate.hold(400);
    gate.deliver(() => delivered.push(1));
    gate.stop();
    vi.advanceTimersByTime(1000);
    expect(delivered).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
