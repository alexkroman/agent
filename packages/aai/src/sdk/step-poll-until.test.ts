// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepPollUntil` on virtual time: the in-step loop, its wall-clock budget, and
 * the step's cancel signal.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { publishStepInfoReader } from "./step-attempt.ts";
import { stepPollUntil } from "./step-poll-until.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  publishStepInfoReader(undefined);
});

describe("stepPollUntil", () => {
  test("checks every everyMs until done", async () => {
    const statuses = ["PENDING", "PENDING", "SUCCEEDED"];
    let i = 0;
    const check = vi.fn(async () => statuses[i++]);
    const polled = stepPollUntil(check, {
      everyMs: 3000,
      maxMs: 60_000,
      done: (s) => s !== "PENDING",
    });
    await vi.advanceTimersByTimeAsync(6000);
    await expect(polled).resolves.toEqual({ value: "SUCCEEDED", done: true, checks: 3 });
    expect(check).toHaveBeenCalledTimes(3);
  });

  test("returns the latest reading once no further wait fits in maxMs", async () => {
    const polled = stepPollUntil(async () => "PENDING", {
      everyMs: 3000,
      maxMs: 10_000,
      done: () => false,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    // Checks at 0, 3 s, 6 s and 9 s; a wait to 12 s would pass the budget.
    await expect(polled).resolves.toEqual({ value: "PENDING", done: false, checks: 4 });
  });

  test("stops on the running step's signal, throwing its reason", async () => {
    const controller = new AbortController();
    publishStepInfoReader(() => ({
      name: "mem0",
      key: "mem0#0",
      attempt: 1,
      maxAttempts: 1,
      isLastAttempt: true,
      signal: controller.signal,
    }));
    const polled = stepPollUntil(async () => "PENDING", {
      everyMs: 3000,
      maxMs: 60_000,
      done: () => false,
    });
    const settled = polled.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort(new Error("cancelled"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled).toEqual(new Error("cancelled"));
  });

  test("refuses an unusable budget", async () => {
    await expect(
      stepPollUntil(() => 1, { everyMs: 0, maxMs: 10, done: () => true }),
    ).rejects.toThrow(RangeError);
    await expect(
      stepPollUntil(() => 1, { everyMs: 10, maxMs: -5, done: () => true }),
    ).rejects.toThrow(RangeError);
  });
});
