// Copyright 2026 the AAI authors. MIT license.
/**
 * The hold store: a payload is taken once, within its window, and the store is
 * bounded.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { useVirtualTime } from "../transports/_pipeline-transport-harness.ts";
import {
  clearHeldSignals,
  heldSignalCount,
  holdSignal,
  MAX_HELD_SIGNALS,
  takeHeldSignal,
} from "./held-signals.ts";

describe("held signals", () => {
  useVirtualTime();
  afterEach(clearHeldSignals);

  test("a hold is taken ONCE, with its payload", () => {
    holdSignal("t", { ok: true }, 1000);
    expect(takeHeldSignal("t")).toEqual({ payload: { ok: true } });
    expect(takeHeldSignal("t")).toBeUndefined();
  });

  test("an expired hold is not taken", () => {
    holdSignal("t", 1, 1000);
    // Virtual time: the clock the store reads is the faked `Date.now`.
    vi.advanceTimersByTime(1001);
    expect(takeHeldSignal("t")).toBeUndefined();
  });

  test("a later hold on the same token REPLACES the earlier one", () => {
    holdSignal("t", "first", 1000);
    holdSignal("t", "second", 1000);
    expect(heldSignalCount()).toBe(1);
    expect(takeHeldSignal("t")).toEqual({ payload: "second" });
  });

  test("is bounded: the oldest hold goes when the cap is reached", () => {
    for (let i = 0; i < MAX_HELD_SIGNALS; i++) holdSignal(`t${i}`, i, 60_000);
    holdSignal("late", "x", 60_000);
    expect(heldSignalCount()).toBe(MAX_HELD_SIGNALS);
    expect(takeHeldSignal("t0")).toBeUndefined();
    expect(takeHeldSignal("late")).toEqual({ payload: "x" });
  });
});
