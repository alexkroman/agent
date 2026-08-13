// Copyright 2026 the AAI authors. MIT license.
/**
 * What this pins is the ISSUE ORDER, not the results.
 *
 * A bounded map that returned the right values in the wrong order would pass an
 * output-only spec and still be unusable in a workflow body, because the Workflow
 * DevKit correlates a journal entry to a step call by the order the call was
 * issued in — see the module doc. So every test here that matters records when
 * each call STARTED, and the settle order is deliberately shuffled against it.
 */

import { describe, expect, test } from "vitest";
import { mapInBatches } from "./map-in-batches.ts";

/** A run that records its own start order and settles after `delay` ticks. */
function recorder(delayOf: (item: number) => number = () => 0) {
  const started: number[] = [];
  const run = async (item: number): Promise<number> => {
    started.push(item);
    for (let tick = 0; tick < delayOf(item); tick++) await Promise.resolve();
    return item * 2;
  };
  return { started, run };
}

describe("mapInBatches", () => {
  test("issues calls in item order however they settle", async () => {
    // The first item is the SLOWEST, so anything driven by completion would
    // reorder here. Issue order is what a replay has to reproduce.
    const { started, run } = recorder((item) => (item === 0 ? 20 : 0));
    await mapInBatches([0, 1, 2, 3], 4, run);
    expect(started).toEqual([0, 1, 2, 3]);
  });

  test("returns results in item order, not completion order", async () => {
    const { run } = recorder((item) => (item === 0 ? 20 : 0));
    expect(await mapInBatches([0, 1, 2, 3], 4, run)).toEqual([0, 2, 4, 6]);
  });

  test("holds the bound: a batch is issued only once its predecessor settles", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapInBatches(
      Array.from({ length: 9 }, (_unused, index) => index),
      4,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
      },
    );
    expect(peak).toBe(4);
  });

  test("passes each item's index in the WHOLE list, not in its batch", async () => {
    // The batch offset is exactly the arithmetic a hand-rolled loop gets wrong,
    // and an index that restarts per batch silently mis-labels every result.
    const seen: [string, number][] = [];
    await mapInBatches(["a", "b", "c", "d", "e"], 2, (item, index) => {
      seen.push([item, index]);
      return Promise.resolve(item);
    });
    expect(seen).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
      ["e", 4],
    ]);
  });

  test("runs nothing for an empty list", async () => {
    const { started, run } = recorder();
    expect(await mapInBatches([], 4, run)).toEqual([]);
    expect(started).toEqual([]);
  });

  test("does not require the list to divide evenly", async () => {
    // A partial final batch is the case a `<` / `<=` slip drops entirely.
    const { run } = recorder();
    expect(await mapInBatches([1, 2, 3, 4, 5], 2, run)).toEqual([2, 4, 6, 8, 10]);
  });

  test.each([0, -3, 0.5, Number.NaN])(
    "floors a size of %p at one rather than hanging",
    async (size) => {
      // `from += 0` never advances: a hang, not an error — and a hang inside a
      // workflow body is a run that never completes and reports nothing.
      const { started, run } = recorder();
      expect(await mapInBatches([1, 2], size, run)).toEqual([2, 4]);
      expect(started).toEqual([1, 2]);
    },
  );

  test("abandons the remaining batches when a call rejects", async () => {
    // The finished siblings are already journaled, so a resume replays them and
    // re-issues only what is missing. Salvaging a partial result is the caller's
    // decision, made inside `run`.
    const started: number[] = [];
    await expect(
      mapInBatches([1, 2, 3, 4], 2, async (item) => {
        started.push(item);
        if (item === 2) throw new Error("segment 2 failed");
        return item;
      }),
    ).rejects.toThrow(/segment 2 failed/);
    expect(started).toEqual([1, 2]);
  });

  test("accepts a synchronous run function", async () => {
    expect(await mapInBatches([1, 2, 3], 2, (item) => item * 3)).toEqual([3, 6, 9]);
  });
});
