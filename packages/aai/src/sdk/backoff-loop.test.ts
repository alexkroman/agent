// Copyright 2026 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createBackoffLoop } from "./backoff-loop.ts";

/** A loop whose every attempt fails at once; returns when each attempt ran. */
function failing(options: { baseMs: number; maxMs: number; jitter: boolean }) {
  const attempts: number[] = [];
  const loop = createBackoffLoop(() => {
    attempts.push(Date.now());
    loop.retry();
  }, options);
  return { attempts, loop };
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - (times[i] as number));
}

describe("createBackoffLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("does nothing until start(), which attempts synchronously", () => {
    const attempt = vi.fn();
    const loop = createBackoffLoop(attempt, { baseMs: 100, maxMs: 1000, jitter: false });
    expect(attempt).not.toHaveBeenCalled();
    loop.start();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test("unjittered: the window doubles from base and stops at max, exactly", async () => {
    const { attempts, loop } = failing({ baseMs: 100, maxMs: 500, jitter: false });
    loop.start();
    await vi.advanceTimersByTimeAsync(2000);
    loop.stop();
    expect(gaps(attempts).slice(0, 5)).toEqual([100, 200, 400, 500, 500]);
  });

  test("jittered: each wait is over the lower half of the window", async () => {
    // `Math.random()` pinned: 0 waits half the window, 0.5 three quarters.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const low = failing({ baseMs: 1000, maxMs: 4000, jitter: true });
    low.loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    low.loop.stop();
    expect(gaps(low.attempts).slice(0, 4)).toEqual([500, 1000, 2000, 2000]);

    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const high = failing({ baseMs: 1000, maxMs: 4000, jitter: true });
    high.loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    high.loop.stop();
    expect(gaps(high.attempts).slice(0, 3)).toEqual([750, 1500, 3000]);
  });

  test("reset() starts the window over at base", async () => {
    let n = 0;
    const attempts: number[] = [];
    const loop = createBackoffLoop(
      () => {
        attempts.push(Date.now());
        n++;
        // The third attempt "works" before failing again.
        if (n === 3) loop.reset();
        loop.retry();
      },
      { baseMs: 100, maxMs: 10_000, jitter: false },
    );
    loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    loop.stop();
    expect(gaps(attempts).slice(0, 4)).toEqual([100, 200, 100, 200]);
  });

  test("stop() cancels the pending attempt and every later retry()", async () => {
    const attempt = vi.fn();
    const loop = createBackoffLoop(attempt, { baseMs: 100, maxMs: 1000, jitter: false });
    loop.start();
    loop.retry();
    expect(loop.stopped()).toBe(false);
    loop.stop();
    expect(loop.stopped()).toBe(true);
    loop.retry();
    loop.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
