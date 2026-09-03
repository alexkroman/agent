// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the bounded stream map.
 *
 * Driven by GATES rather than by timers: every claim here is about what has
 * started before something else finishes, and a spec that expressed that as
 * elapsed milliseconds would be asserting the scheduler's mood. Each task parks on
 * a `Promise.withResolvers` the test opens by hand, so "three are in flight" is a
 * fact the spec establishes rather than one it waits for.
 */

import { describe, expect, test } from "vitest";
import { tick } from "../host/_test-utils.ts";
import { mapStream } from "./_map-stream.ts";

/** A task that parks until the spec lets it through. */
function gate<T>() {
  return Promise.withResolvers<T>();
}

/**
 * One gate per index, minted on first use.
 *
 * A MAP rather than an array, because both sides index it — the mapper by the item
 * it was handed, the spec by the order it wants them released — and an array read
 * is `T | undefined` under `noUncheckedIndexedAccess`, i.e. a `!` per line in a
 * file whose whole subject is which promise settles when.
 */
function gates<T>() {
  const held = new Map<number, PromiseWithResolvers<T>>();
  return {
    at(index: number): PromiseWithResolvers<T> {
      const found = held.get(index) ?? gate<T>();
      held.set(index, found);
      return found;
    },
  };
}

/** Collect everything a stream yields. */
async function drain<R>(stream: AsyncIterable<R>): Promise<R[]> {
  const seen: R[] = [];
  for await (const value of stream) seen.push(value);
  return seen;
}

describe("mapStream", () => {
  test("yields results in source order, whatever order they settle in", async () => {
    const parked = gates<string>();
    const stream = mapStream([0, 1, 2], 3, async (at) => await parked.at(at).promise);
    // Settled back to front: the first result out must still be item 0's.
    parked.at(2).resolve("c");
    parked.at(1).resolve("b");
    parked.at(0).resolve("a");
    expect(await drain(stream)).toEqual(["a", "b", "c"]);
  });

  test("passes each item its index", async () => {
    const seen: [number, number][] = [];
    await drain(
      mapStream([10, 20, 30], 2, (item, at) => {
        seen.push([item, at]);
        return item;
      }),
    );
    expect(seen).toEqual([
      [10, 0],
      [20, 1],
      [30, 2],
    ]);
  });

  test("keeps at most `width` tasks in flight, and refills as each one lands", async () => {
    const parked = gates<number>();
    let started = 0;
    let peak = 0;
    let live = 0;
    const stream = mapStream([0, 1, 2, 3, 4], 2, async (at) => {
      started += 1;
      live += 1;
      peak = Math.max(peak, live);
      const value = await parked.at(at).promise;
      live -= 1;
      return value;
    });
    const collected = drain(stream);
    // Nothing is pulled until the consumer asks, so the window fills on the first
    // `next()` — two items, not five. A MACROTASK, because walking an async
    // iterator to the edge of its window is several microtask turns deep and a
    // single yield would assert on a half-filled window.
    await tick();
    expect(started).toBe(2);
    for (const at of [0, 1, 2, 3, 4]) parked.at(at).resolve(at);
    expect(await collected).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  test("pulls the next item while earlier tasks are still running", async () => {
    // The whole reason this exists: reading the source and doing the work overlap.
    const held = gate<string>();
    const pulled: number[] = [];
    async function* source(): AsyncGenerator<number> {
      for (const at of [0, 1, 2]) {
        pulled.push(at);
        yield at;
      }
    }
    const stream = mapStream(source(), 3, async (at) => (at === 0 ? await held.promise : "fast"));
    const collected = drain(stream);
    // Item 0 is parked, and the source has been walked to the end regardless.
    await tick();
    expect(pulled).toEqual([0, 1, 2]);
    held.resolve("slow");
    expect(await collected).toEqual(["slow", "fast", "fast"]);
  });

  test("stops pulling once a task has failed, and throws its error", async () => {
    const pulled: number[] = [];
    async function* source(): AsyncGenerator<number> {
      for (const at of [0, 1, 2, 3, 4, 5]) {
        pulled.push(at);
        yield at;
      }
    }
    const boom = new Error("part refused");
    const stream = mapStream(source(), 2, (at) => {
      if (at === 0) throw boom;
      return at;
    });
    await expect(drain(stream)).rejects.toThrow(boom);
    // The window's width, and not one item more: the source is never asked again.
    expect(pulled).toEqual([0, 1]);
  });

  test("waits for the tasks still in flight before the failure escapes", async () => {
    // A rejection nobody is waiting on yet is an unhandled rejection, and an
    // in-flight task the caller cannot see is a write racing its own cleanup.
    const slow = gate<number>();
    let settled = false;
    const stream = mapStream([0, 1], 2, async (at) => {
      if (at === 0) throw new Error("first");
      await slow.promise;
      settled = true;
      return at;
    });
    const failing = drain(stream);
    await tick();
    expect(settled).toBe(false);
    slow.resolve(1);
    await expect(failing).rejects.toThrow("first");
    expect(settled).toBe(true);
  });

  test("a sibling that rejects behind the head is settled, not left unhandled", async () => {
    const unhandled: unknown[] = [];
    const record = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", record);
    try {
      const held = gate<number>();
      const stream = mapStream([0, 1], 2, async (at) => {
        if (at === 1) throw new Error("second");
        return await held.promise;
      });
      const collected = drain(stream);
      // Item 1 has already rejected while item 0 — the head — is still parked.
      await tick();
      held.resolve(0);
      await expect(collected).rejects.toThrow("second");
      // A macrotask, which is when Node decides a rejection went unobserved.
      await tick();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  test("a consumer that leaves early settles what is in flight and closes the source", async () => {
    const held = gate<number>();
    let closed = false;
    let landed = false;
    async function* source(): AsyncGenerator<number> {
      try {
        yield* [0, 1, 2, 3];
      } finally {
        closed = true;
      }
    }
    const stream = mapStream(source(), 2, async (at) => {
      if (at === 0) return at;
      await held.promise;
      landed = true;
      return at;
    });
    for await (const first of stream) {
      expect(first).toBe(0);
      held.resolve(1);
      break;
    }
    expect(landed).toBe(true);
    expect(closed).toBe(true);
  });

  test("an empty source yields nothing and never calls the mapper", async () => {
    let called = 0;
    const seen = await drain(
      mapStream([], 4, () => {
        called += 1;
        return 1;
      }),
    );
    expect(seen).toEqual([]);
    expect(called).toBe(0);
  });

  test.each([
    ["zero", 0],
    ["negative", -3],
    ["fractional", 1.9],
    ["not a number", Number.NaN],
  ])("a %s width still maps every item, one at a time", async (_label, width) => {
    let peak = 0;
    let live = 0;
    const seen = await drain(
      mapStream([1, 2, 3], width, async (item) => {
        live += 1;
        peak = Math.max(peak, live);
        await Promise.resolve();
        live -= 1;
        return item * 2;
      }),
    );
    expect(seen).toEqual([2, 4, 6]);
    expect(peak).toBe(1);
  });

  test("a source that throws mid-walk propagates once the head has been yielded", async () => {
    async function* source(): AsyncGenerator<number> {
      yield 0;
      throw new Error("body too large");
    }
    const stream = mapStream(source(), 1, (at) => at);
    await expect(drain(stream)).rejects.toThrow("body too large");
  });
});
