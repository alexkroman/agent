// Copyright 2026 the AAI authors. MIT license.
/**
 * The three properties a caller reasons about, stated as properties rather
 * than as one sampled draw: the result is jittered, so a spec that asserts an
 * exact number is asserting the seed.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { jitteredBackoff } from "./jittered-backoff.ts";

describe("jitteredBackoff", () => {
  test("never exceeds the window it computed, and never falls below its half", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 5000 }),
        (attempt, baseMs) => {
          const window = baseMs * 2 ** (attempt - 1);
          const delay = jitteredBackoff(attempt, { baseMs });
          // The bound that lets a caller compute its total budget from
          // `baseMs` and its attempt count without knowing the draw.
          expect(delay).toBeGreaterThanOrEqual(window / 2);
          expect(delay).toBeLessThan(window);
        },
      ),
    );
  });

  test("maxMs caps the window, so a long retry loop cannot reach minutes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (attempt) => {
        const delay = jitteredBackoff(attempt, { baseMs: 500, maxMs: 10_000 });
        expect(delay).toBeGreaterThanOrEqual(500 / 2);
        expect(delay).toBeLessThanOrEqual(10_000);
      }),
    );
  });

  test("attempt is 1-BASED: the first wait is drawn from the base window", () => {
    // An off-by-one here doubles or halves every wait in the repo silently,
    // which is why it is pinned rather than left to the doc.
    for (let i = 0; i < 50; i++) {
      const delay = jitteredBackoff(1, { baseMs: 1000 });
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThan(1000);
    }
  });

  test("successive attempts widen the range they draw from", () => {
    // The doubling survives the jitter: attempt 4's floor is above attempt 1's
    // ceiling, so the growth is observable without depending on a draw.
    expect(jitteredBackoff(4, { baseMs: 100 })).toBeGreaterThanOrEqual(400);
    expect(jitteredBackoff(1, { baseMs: 100 })).toBeLessThan(200);
  });
});
