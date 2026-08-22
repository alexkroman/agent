// Copyright 2026 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCoalescingTimer, createRestartableTimer } from "./_timer.ts";

describe("timer callbacks are throw-contained", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("createRestartableTimer survives a throwing onElapsed", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const timer = createRestartableTimer(() => {
      calls++;
      throw new Error("callback boom");
    });
    timer.arm(10);
    // A throw from the callback runs on the timer tick — it must be contained
    // (logged), not surface as an uncaughtException.
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(calls).toBe(1);
    expect(timer.pending()).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    // The timer stays usable after the throw.
    timer.arm(10);
    vi.advanceTimersByTime(10);
    expect(calls).toBe(2);
  });

  test("createCoalescingTimer survives a throwing onElapsed", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const timer = createCoalescingTimer(() => {
      calls++;
      throw new Error("callback boom");
    });
    timer.arm(10);
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(calls).toBe(1);
    expect(timer.pending()).toBe(false);
  });
});
