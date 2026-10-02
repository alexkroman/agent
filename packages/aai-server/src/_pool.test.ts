// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { mapConcurrent } from "./_pool.ts";

describe("mapConcurrent", () => {
  test("resolves results in ITEM order, not completion order", async () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const run = mapConcurrent([0, 1], 2, async (item) => {
      await gates[item]?.promise;
      return `r${item}`;
    });
    gates[1]?.resolve();
    gates[0]?.resolve();
    await expect(run).resolves.toEqual(["r0", "r1"]);
  });

  test("never has more than `concurrency` calls in flight, and visits every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapConcurrent([1, 2, 3, 4, 5, 6, 7], 3, async (item, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      seen.push(index);
      inFlight -= 1;
      return item;
    });
    expect(peak).toBe(3);
    expect(seen.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("a non-positive concurrency still makes progress with one worker", async () => {
    await expect(mapConcurrent(["a", "b"], 0, async (s) => s.toUpperCase())).resolves.toEqual([
      "A",
      "B",
    ]);
  });

  test("an empty list resolves to an empty result without calling fn", async () => {
    let calls = 0;
    await expect(
      mapConcurrent([], 4, async () => {
        calls += 1;
      }),
    ).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  test("rejects with the first failure", async () => {
    await expect(
      mapConcurrent([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
