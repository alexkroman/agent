// Copyright 2026 the AAI authors. MIT license.
/**
 * What this pins is the ISSUE ORDER, not the results.
 *
 * A bounded map that returned the right values in the wrong order would pass an
 * output-only spec and still be unusable in a workflow body, because the Workflow
 * DevKit correlates a journal entry to a step call by the order the call was
 * issued in — see the module doc. So every test here that matters records when
 * each call STARTED, and the settle order is deliberately shuffled against it.
 *
 * The specs that are new since this was `mapInBatches` are the two that separate a
 * window from a barrier: `started` stays a pure function of the list at every
 * width and under every settle order (which is what makes the window legal), and
 * a slow item does not hold its siblings' successors back (which is what makes it
 * worth having). `aai-cli/dev-workflow.scenario.test.ts` covers the other half
 * against a REAL WDK world — that these are genuine steps through the transform —
 * and deliberately not this one: a healthy run is not a resume, so the issue-order
 * property is asserted HERE, directly, or nowhere.
 */

// `tick` from `host/_test-utils.ts` rather than a local yield: `guard-invariants`
// rule 4 exists to stop a seventh spelling of it, and `_map-stream.test.ts`
// already reaches across for the same reason.
import { describe, expect, test, vi } from "vitest";
import { tick } from "../host/_test-utils.ts";
import { mapConcurrent } from "./map-concurrent.ts";

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

describe("mapConcurrent", () => {
  test("issues calls in item order however they settle", async () => {
    // The first item is the SLOWEST, so anything driven by completion would
    // reorder here. Issue order is what a replay has to reproduce.
    const { started, run } = recorder((item) => (item === 0 ? 20 : 0));
    await mapConcurrent([0, 1, 2, 3], 4, run);
    expect(started).toEqual([0, 1, 2, 3]);
  });

  test.each([1, 2, 3, 5, 8])(
    "issues in item order at width %i, with the settle order reversed",
    async (width) => {
      // THE replay property, and the one a window has to earn: the cursor only
      // ever hands out the next index, so the sequence of items whose calls are
      // issued is decided by the list and by nothing else — at any width, and
      // with completion order the exact reverse of it.
      const items = [0, 1, 2, 3, 4, 5, 6];
      const { started, run } = recorder((item) => (items.length - item) * 3);
      await mapConcurrent(items, width, run);
      expect(started).toEqual(items);
    },
  );

  test("issues the SAME sequence whichever order the calls settle in", async () => {
    // A replay takes different times, so this is that difference made explicit:
    // two runs of the same list, one settling forwards and one backwards, have to
    // agree call for call or the DevKit hands the Nth id to a different item.
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const forwards = recorder((item) => item * 3);
    const backwards = recorder((item) => (items.length - item) * 3);
    await mapConcurrent(items, 3, forwards.run);
    await mapConcurrent(items, 3, backwards.run);
    expect(backwards.started).toEqual(forwards.started);
    expect(forwards.started).toEqual(items);
  });

  test("does NOT wait for a slow item before starting its siblings' successors", async () => {
    // The whole reason this is a window rather than sequential batches. Item 0
    // takes as long as the rest of the list put together; under a barrier nothing
    // past item 1 could start until it landed, so a batch's wall time was its
    // slowest member and a run was the sum of those.
    const events: string[] = [];
    await mapConcurrent([0, 1, 2, 3], 2, async (item) => {
      events.push(`start ${item}`);
      for (let tick = 0; tick < (item === 0 ? 30 : 1); tick++) await Promise.resolve();
      events.push(`done ${item}`);
    });
    // Items 2 and 3 both went while item 0 was still in flight.
    expect(events.indexOf("start 2")).toBeLessThan(events.indexOf("done 0"));
    expect(events.indexOf("start 3")).toBeLessThan(events.indexOf("done 0"));
  });

  test("returns results in item order, not completion order", async () => {
    const { run } = recorder((item) => (item === 0 ? 20 : 0));
    expect(await mapConcurrent([0, 1, 2, 3], 4, run)).toEqual([0, 2, 4, 6]);
  });

  test("holds the bound: never more than `size` calls in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(
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

  test("lets the whole rest of a list finish behind ONE slow item", async () => {
    // The same property as the test above at the scale it is felt: a barrier
    // pays its slowest member once per round, so a single straggler — a `503`
    // carrying `retry-after` is the ordinary one — held back every item in every
    // later round. Here it holds back nothing at all.
    const items = Array.from({ length: 12 }, (_unused, index) => index);
    const finished: number[] = [];
    await mapConcurrent(items, 4, async (item) => {
      for (let tick = 0; tick < (item === 0 ? 200 : 1); tick++) await Promise.resolve();
      finished.push(item);
    });
    // Item 0 is last to finish and cost nobody else a thing.
    expect(finished.at(-1)).toBe(0);
    expect(finished.slice(0, -1)).toEqual(items.slice(1));
  });

  test("passes each item's index in the WHOLE list", async () => {
    // The index a caller labels a result with — and the arithmetic a hand-rolled
    // loop gets wrong, silently mis-labelling every result.
    const seen: [string, number][] = [];
    await mapConcurrent(["a", "b", "c", "d", "e"], 2, (item, index) => {
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
    expect(await mapConcurrent([], 4, run)).toEqual([]);
    expect(started).toEqual([]);
  });

  test("does not require the list to divide evenly", async () => {
    const { run } = recorder();
    expect(await mapConcurrent([1, 2, 3, 4, 5], 2, run)).toEqual([2, 4, 6, 8, 10]);
  });

  test("starts no more slots than there are items", async () => {
    // A width past the list would otherwise start empty slots — harmless, and
    // still worth pinning, because the arithmetic that stops it is the same
    // `Math.min` that a non-finite size has to survive below.
    let slots = 0;
    await mapConcurrent([1, 2], 100, (item) => {
      slots += 1;
      return item;
    });
    expect(slots).toBe(2);
  });

  test.each([0, -3, 0.5, Number.NaN])(
    "floors a size of %p at one rather than mapping nothing",
    async (size) => {
      // Zero slots is a hang for a barrier and an empty result for a window —
      // and an empty result is worse, because it reads as an empty input.
      const { started, run } = recorder();
      expect(await mapConcurrent([1, 2], size, run)).toEqual([2, 4]);
      expect(started).toEqual([1, 2]);
    },
  );

  test("stops taking new items when a call rejects", async () => {
    // The finished siblings are already journaled, so a resume replays them and
    // re-issues only what is missing. Salvaging a partial result is the caller's
    // decision, made inside `run`.
    //
    // "Stops" is BEST EFFORT and cannot be otherwise: a sibling slot that is
    // already looping takes its next item before anyone can observe the
    // rejection, so the guarantee is that the map does not work through the rest
    // of the list — not that it stops on a particular index. It cannot affect
    // replay either way, because the cursor is still monotonic.
    const items = Array.from({ length: 20 }, (_unused, index) => index);
    const started: number[] = [];
    await expect(
      mapConcurrent(items, 2, async (item) => {
        started.push(item);
        if (item === 1) throw new Error("segment 1 failed");
        return item;
      }),
    ).rejects.toThrow(/segment 1 failed/);
    // A prefix of the list, and a short one — never the whole of it.
    expect(started).toEqual(items.slice(0, started.length));
    expect(started.length).toBeLessThan(5);
  });

  test("waits for in-flight siblings to SETTLE before the rejection propagates", async () => {
    // The property a durable fan-out actually needs. `Promise.all` rejects the
    // instant one slot does, which abandons the calls already running — and in a
    // workflow those are steps that have been paid for, whose journal entries
    // never land, so the resume re-issues and re-bills work that SUCCEEDED. The
    // DevKit names them: "run failed with N uncommitted operation(s)".
    const finished: number[] = [];
    const slowSibling = Promise.withResolvers<void>();

    const mapped = mapConcurrent([0, 1], 2, async (item) => {
      if (item === 0) throw new Error("segment 0 failed");
      await slowSibling.promise;
      finished.push(item);
      return item;
    });
    const settled = vi.fn();
    void mapped.catch(settled);

    // Item 0 has rejected by now; the map must NOT have settled, because item 1
    // is still in flight. This is the assertion that fails against `Promise.all`.
    await tick();
    expect(settled).not.toHaveBeenCalled();
    expect(finished).toEqual([]);

    slowSibling.resolve();
    await expect(mapped).rejects.toThrow(/segment 0 failed/);
    // And the sibling's work completed rather than being discarded.
    expect(finished).toEqual([1]);
  });

  test("raises the CAUSAL failure, not whichever sibling the drain waited on", async () => {
    // The one that draining puts at risk, and it is not hypothetical: the parts
    // uploader aborts its in-flight siblings the moment one part is refused, so
    // every other slot then fails with `aborted`. Raising one of those names the
    // symptom to a caller whose real problem is that a part was REFUSED — which
    // is exactly what `sendEveryPart`'s doc says must not happen.
    //
    // First-in-time is what makes it the cause: every later rejection here is
    // downstream of the first, either through `stopped` or through the caller's
    // own abort.
    const siblings = new AbortController();
    const held = Promise.withResolvers<void>();
    siblings.signal.addEventListener("abort", () => {
      held.resolve();
    });

    await expect(
      mapConcurrent([0, 1], 2, async (item) => {
        if (item === 1) {
          siblings.abort();
          throw new Error("part refused");
        }
        await held.promise;
        throw new Error("aborted");
      }),
    ).rejects.toThrow(/part refused/);
  });

  test("accepts a synchronous run function", async () => {
    expect(await mapConcurrent([1, 2, 3], 2, (item) => item * 3)).toEqual([3, 6, 9]);
  });
});
