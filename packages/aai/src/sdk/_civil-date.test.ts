// Copyright 2026 the AAI authors. MIT license.
/**
 * `calendar.test.ts` and `spoken-render.test.ts` both exercise this through
 * their own surfaces; what is asserted HERE is the property that makes it worth
 * being one function — the round-trip that separates a real date from a string
 * matching the shape — plus the triple it hands back, which neither caller
 * exposes directly.
 */
import { describe, expect, test } from "vitest";

import { isoDateParts } from "./_civil-date.ts";

describe("isoDateParts", () => {
  test("answers the three numbers of a real date", () => {
    expect(isoDateParts("2026-06-08")).toEqual([2026, 6, 8]);
    expect(isoDateParts("0001-01-01")).toEqual([1, 1, 1]);
  });

  test("months and days come back UNSHIFTED", () => {
    // The trap in a function built on `Date.UTC`, which counts months from 0:
    // both callers pass the middle number straight into `MONTHS[m - 1]` and
    // `Date.UTC(y, m - 1, d)`, so a zero-based answer here would be off by one
    // in the rendered month AND in every date computed from it.
    expect(isoDateParts("2026-01-31")).toEqual([2026, 1, 31]);
    expect(isoDateParts("2026-12-01")).toEqual([2026, 12, 1]);
  });

  test("refuses a date that matches the shape and is not one", () => {
    // The round-trip is the whole reason this is a function: `Date.UTC`
    // NORMALIZES out of range rather than rejecting, so February 30th becomes
    // March 2nd and the day stops matching.
    expect(isoDateParts("2026-02-30")).toBeUndefined();
    expect(isoDateParts("2025-02-29")).toBeUndefined();
    expect(isoDateParts("2026-04-31")).toBeUndefined();
    expect(isoDateParts("2026-13-01")).toBeUndefined();
    expect(isoDateParts("2026-00-01")).toBeUndefined();
    expect(isoDateParts("2026-01-00")).toBeUndefined();
  });

  test("accepts a leap day in a leap year and refuses it otherwise", () => {
    expect(isoDateParts("2024-02-29")).toEqual([2024, 2, 29]);
    expect(isoDateParts("2000-02-29")).toEqual([2000, 2, 29]); // divisible by 400
    expect(isoDateParts("1900-02-29")).toBeUndefined(); // divisible by 100, not 400
  });

  test("refuses anything that is not exactly YYYY-MM-DD", () => {
    for (const value of [
      "6/8/2026",
      "2026-6-8",
      "2026-06-08T00:00:00Z",
      "2026-06-08 ",
      " 2026-06-08",
      "26-06-08",
      "",
      "tomorrow",
    ]) {
      expect(isoDateParts(value)).toBeUndefined();
    }
  });
});
