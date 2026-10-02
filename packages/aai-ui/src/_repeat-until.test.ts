// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `repeatUntil`, the bounded-read loop under both workflow watchers.
 *
 * The two rules its doc names are the two asserted here: the next read is
 * armed from the SETTLED one (never on an interval, so a slow answer cannot
 * stack requests), and stopping reaches the read in flight through its signal.
 * Virtual time throughout, because every case observes a timer.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { repeatUntil } from "./_repeat-until.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("repeatUntil", () => {
  test("runs the first step at once and stops when it reports finished", async () => {
    const step = vi.fn(async () => true);
    repeatUntil(100, step);
    await vi.advanceTimersByTimeAsync(0);
    expect(step).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1000);
    expect(step).toHaveBeenCalledOnce();
  });

  test("comes back one interval after each unfinished step", async () => {
    const step = vi.fn(async () => step.mock.calls.length >= 3);
    repeatUntil(100, step);
    await vi.advanceTimersByTimeAsync(0);
    expect(step).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(step).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(step).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(step).toHaveBeenCalledTimes(3);

    // The third answered `true`, so nothing is armed after it.
    await vi.advanceTimersByTimeAsync(1000);
    expect(step).toHaveBeenCalledTimes(3);
  });

  test("arms the next read from the SETTLED one, so a slow answer stacks nothing", async () => {
    const answer = Promise.withResolvers<boolean>();
    const step = vi.fn(() => answer.promise);
    repeatUntil(100, step);
    await vi.advanceTimersByTimeAsync(0);

    // Ten intervals pass with the first read still out: an interval would have
    // fired ten more by now.
    await vi.advanceTimersByTimeAsync(1000);
    expect(step).toHaveBeenCalledOnce();

    answer.resolve(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(step).toHaveBeenCalledTimes(2);
  });

  test("stopping aborts the signal the in-flight step was handed", async () => {
    const signals: AbortSignal[] = [];
    const stop = repeatUntil(100, (signal) => {
      signals.push(signal);
      return new Promise<boolean>(() => undefined);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(signals[0]?.aborted).toBe(false);

    stop();
    expect(signals[0]?.aborted).toBe(true);
  });

  test("stopping between steps clears the armed timer", async () => {
    const step = vi.fn(async () => false);
    const stop = repeatUntil(100, step);
    await vi.advanceTimersByTimeAsync(0);
    expect(step).toHaveBeenCalledOnce();

    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(step).toHaveBeenCalledOnce();
  });

  test("a step that settles after the stop arms nothing", async () => {
    const answer = Promise.withResolvers<boolean>();
    const step = vi.fn(() => answer.promise);
    const stop = repeatUntil(100, step);
    await vi.advanceTimersByTimeAsync(0);

    stop();
    // The step ignored its signal and answered "not finished" anyway.
    answer.resolve(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(step).toHaveBeenCalledOnce();
  });
});
