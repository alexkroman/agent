// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { waitForIdle } from "./_drain.ts";

describe("waitForIdle", () => {
  test("returns immediately when nothing is in flight", async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(waitForIdle({ activeCount: () => 0, timeoutMs: 10_000, sleep })).resolves.toEqual({
      drained: true,
      remaining: 0,
    });
    // A deploy with no live calls must not pay the poll interval.
    expect(sleep).not.toHaveBeenCalled();
  });

  test("polls until the last session ends", async () => {
    let count = 3;
    const sleep = vi.fn(async () => {
      count -= 1;
    });
    await expect(
      waitForIdle({ activeCount: () => count, timeoutMs: 10_000, pollMs: 100, sleep }),
    ).resolves.toEqual({ drained: true, remaining: 0 });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  test("gives up at the deadline and reports what is still connected", async () => {
    // The caller force-closes the remainder, so it has to know there was one —
    // a silent give-up would look identical to a clean drain in the logs.
    let elapsed = 0;
    const sleep = vi.fn(async (ms: number) => {
      elapsed += ms;
    });
    await expect(
      waitForIdle({
        activeCount: () => 2,
        timeoutMs: 500,
        pollMs: 100,
        sleep,
        now: () => elapsed,
      }),
    ).resolves.toEqual({ drained: false, remaining: 2 });
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  test("a zero timeout still reports the truth rather than claiming drained", async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(
      waitForIdle({ activeCount: () => 1, timeoutMs: 0, sleep, now: () => 0 }),
    ).resolves.toEqual({ drained: false, remaining: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });
});
