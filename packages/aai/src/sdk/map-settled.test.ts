// Copyright 2026 the AAI authors. MIT license.
/**
 * Two claims: a failure is a VALUE beside its item and stops nothing, and the
 * issue order is `mapConcurrent`'s — a pure function of the list — including
 * under the one width this module adds a meaning for.
 */

import { describe, expect, test } from "vitest";
import { mapSettled, partitionSettled } from "./map-settled.ts";

/** A run that records its own start order and fails on the items named. */
function recorder(failing: readonly number[] = [], delayOf: (item: number) => number = () => 0) {
  const started: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const run = async (item: number): Promise<number> => {
    started.push(item);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      for (let tick = 0; tick < delayOf(item); tick++) await Promise.resolve();
      if (failing.includes(item)) throw new Error(`no ${item}`);
      return item * 2;
    } finally {
      inFlight -= 1;
    }
  };
  return { started, run, peak: () => peak };
}

describe("mapSettled", () => {
  test("answers one settled entry per item, in item order", async () => {
    const { run } = recorder();
    expect(await mapSettled([1, 2, 3], 2, run)).toEqual([
      { item: 1, ok: true, value: 2 },
      { item: 2, ok: true, value: 4 },
      { item: 3, ok: true, value: 6 },
    ]);
  });

  test("a failing item is a value beside its item, and its siblings all land", async () => {
    const { run, started } = recorder([2]);
    const settled = await mapSettled([1, 2, 3, 4], 2, run);
    expect(settled).toEqual([
      { item: 1, ok: true, value: 2 },
      { item: 2, ok: false, error: "no 2" },
      { item: 3, ok: true, value: 6 },
      { item: 4, ok: true, value: 8 },
    ]);
    // The window kept going: every item was issued, in order.
    expect(started).toEqual([1, 2, 3, 4]);
  });

  test("the error is a sentence via errorMessage, whatever was thrown", async () => {
    const settled = await mapSettled(["a", "b"], 1, (item) =>
      Promise.reject(item === "a" ? "a bare string" : undefined),
    );
    expect(settled.map((one) => (one.ok ? "ok" : one.error))).toEqual([
      "a bare string",
      expect.any(String),
    ]);
  });

  test("a synchronous throw inside run is settled like a rejection", async () => {
    const settled = await mapSettled([1], 4, () => {
      throw new Error("sync");
    });
    expect(settled).toEqual([{ item: 1, ok: false, error: "sync" }]);
  });

  test("issues calls in item order however they settle — mapConcurrent's rule holds", async () => {
    // Item 1 is slow; 2 and 3 settle before it, and 4 is issued when 2 frees a
    // slot. The START order is still the list's.
    const { run, started } = recorder([], (item) => (item === 1 ? 6 : 0));
    const settled = await mapSettled([1, 2, 3, 4], 2, run);
    expect(started).toEqual([1, 2, 3, 4]);
    expect(settled.map((one) => one.item)).toEqual([1, 2, 3, 4]);
  });

  test("width Infinity issues every item at once — the allSettled shape", async () => {
    const { run, peak } = recorder([], () => 2);
    await mapSettled([1, 2, 3, 4, 5], Number.POSITIVE_INFINITY, run);
    expect(peak()).toBe(5);
  });

  test("a finite width still bounds the window", async () => {
    const { run, peak } = recorder([], () => 2);
    await mapSettled([1, 2, 3, 4, 5], 2, run);
    expect(peak()).toBe(2);
  });

  test("an empty list resolves [] and issues nothing, at any width", async () => {
    const { run, started } = recorder();
    expect(await mapSettled([], Number.POSITIVE_INFINITY, run)).toEqual([]);
    expect(await mapSettled([], 3, run)).toEqual([]);
    expect(started).toEqual([]);
  });

  test("run receives the index", async () => {
    const seen: number[] = [];
    await mapSettled(["a", "b"], 1, (_item, index) => {
      seen.push(index);
    });
    expect(seen).toEqual([0, 1]);
  });
});

describe("partitionSettled", () => {
  test("splits the two arms, each in item order and each typed", async () => {
    const { run } = recorder([2, 4]);
    const { ok, failed } = partitionSettled(await mapSettled([1, 2, 3, 4], 2, run));
    expect(ok.map((one) => [one.item, one.value])).toEqual([
      [1, 2],
      [3, 6],
    ]);
    // Typed as the failure arm: `.error` reads without re-narrowing.
    expect(failed.map((one) => one.error)).toEqual(["no 2", "no 4"]);
    expect(failed[0]?.item).toBe(2);
  });

  test("an all-failed run is an empty `ok` and a first failure to quote", async () => {
    const { ok, failed } = partitionSettled(
      await mapSettled([1, 2], 2, () => {
        throw new Error("gateway said no");
      }),
    );
    expect(ok).toEqual([]);
    expect(failed[0]?.error ?? "no reason given").toBe("gateway said no");
  });
});
