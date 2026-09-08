// Copyright 2026 the AAI authors. MIT license.
/**
 * The two claims worth pinning are the ones a call site gets wrong by hand: the
 * edges of `randomInt` (which decide whether a shuffle can index past the end)
 * and that `shuffled` is a permutation of a copy rather than of the input.
 */
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { createSeededRandom, pickOne, randomInt, shuffled } from "./random.ts";

describe("randomInt", () => {
  test("spans the range and stays inside it", () => {
    expect(randomInt(6, () => 0)).toBe(0);
    expect(randomInt(6, () => 0.5)).toBe(3);
    expect(randomInt(6, () => 0.999_999)).toBe(5);
  });

  test("clamps a source that returns exactly 1", () => {
    // Outside `Math.random`'s contract and well inside what a hand-written
    // stub does. Unclamped this indexes one past the end of every list.
    expect(randomInt(6, () => 1)).toBe(5);
  });

  test("answers 0 for a range with nothing in it", () => {
    for (const max of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(randomInt(max, () => 0.5)).toBe(0);
    }
  });
});

describe("pickOne", () => {
  test("picks by position", () => {
    const items = ["north", "south", "east", "west"];
    expect(pickOne(items, () => 0)).toBe("north");
    expect(pickOne(items, () => 0.999_999)).toBe("west");
  });

  test("answers undefined for an empty list rather than throwing", () => {
    expect(pickOne([], () => 0)).toBeUndefined();
  });

  test("can return a falsy item", () => {
    // The `?? fallback` spelling this replaces cannot: it would substitute the
    // fallback for a legitimately picked 0 or "".
    expect(pickOne([0, 0], () => 0)).toBe(0);
  });
});

describe("shuffled", () => {
  test("returns a permutation and leaves the input alone", () => {
    const input = Object.freeze([1, 2, 3, 4, 5]);
    const out = shuffled(input, createSeededRandom(7));
    expect([...out].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  test("does not mutate a frozen input", () => {
    // A slot's value is deep-frozen, so an in-place shuffle is a TypeError.
    expect(() => shuffled(Object.freeze(["a", "b"]), createSeededRandom(1))).not.toThrow();
  });

  test("is uniform enough that every item reaches every position", () => {
    // The check that separates Fisher-Yates from the biased loop that draws j
    // from the whole range: over many runs each item must reach each slot.
    const random = createSeededRandom(99);
    const seen = [new Set<string>(), new Set<string>(), new Set<string>()];
    for (let i = 0; i < 200; i++) {
      const out = shuffled(["a", "b", "c"], random);
      for (const [at, item] of out.entries()) seen[at]?.add(item);
    }
    for (const slot of seen) expect(slot.size).toBe(3);
  });

  test("handles the empty and single-item lists", () => {
    expect(shuffled([], () => 0.5)).toEqual([]);
    expect(shuffled(["only"], () => 0.5)).toEqual(["only"]);
  });
});

describe("createSeededRandom", () => {
  test("repeats its sequence for a seed", () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const first = Array.from({ length: 20 }, a);
    expect(Array.from({ length: 20 }, b)).toEqual(first);
  });

  test("differs between seeds", () => {
    const a = Array.from({ length: 20 }, createSeededRandom(1));
    const b = Array.from({ length: 20 }, createSeededRandom(2));
    expect(a).not.toEqual(b);
  });

  test("stays inside [0, 1) and actually VARIES", () => {
    // The property a constant source fails, and the reason the test default is
    // seeded rather than `() => 0.5`: `shuffled` and `mintCode` both degenerate
    // on a source that never moves.
    const random = createSeededRandom(2026);
    const draws = Array.from({ length: 500 }, random);
    for (const v of draws) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(draws).size).toBeGreaterThan(400);
  });

  test("survives a seed that is negative or fractional", () => {
    for (const seed of [-1, 0, 3.7, 2 ** 33]) {
      const draws = Array.from({ length: 5 }, createSeededRandom(seed));
      for (const v of draws) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });
});

/**
 * Value-level properties. The two that matter are the ones a hand-written table
 * cannot state: `randomInt` stays in range for EVERY source a stub might be,
 * and `shuffled` is always a permutation.
 */
describe("random properties", () => {
  /** Anything a hand-written stub might return, including out-of-contract values. */
  const sources = fc.double({ min: 0, max: 1, noNaN: true }).map((v) => () => v);

  test("randomInt stays inside [0, max) for any source", () => {
    // Including a source that returns exactly 1, which is outside
    // `Math.random`'s contract and squarely inside what a stub does.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), sources, (max, random) => {
        const n = randomInt(max, random);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThan(max);
      }),
    );
  });

  test("pickOne only ever returns a member of the list", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { minLength: 1 }), sources, (items, random) => {
        expect(items).toContain(pickOne(items, random));
      }),
    );
  });

  test("shuffled is a permutation of its input, and leaves it alone", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.integer(), (items, seed) => {
        const frozen = Object.freeze([...items]);
        const out = shuffled(frozen, createSeededRandom(seed));
        expect(out).toHaveLength(items.length);
        expect([...out].sort((a, b) => a - b)).toEqual([...items].sort((a, b) => a - b));
        expect([...frozen]).toEqual(items);
      }),
    );
  });

  test("createSeededRandom is a pure function of its seed", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 50 }), (seed, draws) => {
        const first = Array.from({ length: draws }, createSeededRandom(seed));
        const second = Array.from({ length: draws }, createSeededRandom(seed));
        expect(second).toEqual(first);
        for (const v of first) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(1);
        }
      }),
    );
  });
});
