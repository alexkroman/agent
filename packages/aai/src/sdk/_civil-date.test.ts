// Copyright 2026 the AAI authors. MIT license.
/**
 * `calendar.test.ts` and `spoken-render.test.ts` both exercise this through
 * their own surfaces; what is asserted HERE is the property that makes it worth
 * being one function — the round-trip that separates a real date from a string
 * matching the shape — plus the triple it hands back, which neither caller
 * exposes directly.
 */
import { describe, expect, test } from "vitest";

import { isoDateParts, utcDate } from "./_civil-date.ts";

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

describe("utcDate", () => {
  test("takes a 1-based month, like every caller's ISO string", () => {
    expect(utcDate(2026, 6, 8).toISOString()).toBe("2026-06-08T00:00:00.000Z");
    expect(utcDate(2026, 1, 1).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(utcDate(2026, 12, 31).toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  test("normalizes a day out of range, which is what isoDateParts reads", () => {
    expect(utcDate(2026, 2, 30).toISOString().slice(0, 10)).toBe("2026-03-02");
    expect(utcDate(2026, 6, 0).toISOString().slice(0, 10)).toBe("2026-05-31");
  });

  test("puts a year under 100 in the right century", () => {
    // `Date.UTC(1, 0, 1)` is 1901. This is the trap the whole module exists for.
    expect(utcDate(1, 1, 1).getUTCFullYear()).toBe(1);
    expect(utcDate(0, 1, 1).getUTCFullYear()).toBe(0);
    expect(utcDate(99, 12, 31).getUTCFullYear()).toBe(99);
  });

  test("normalizes the day INSIDE that century — the ordering bug", () => {
    // Correcting the year after the fact is too late: 1999-12-32 rolls to
    // 2000-01-01, and stamping year 99 on that gives 0099-01-01, a year wrong.
    expect(utcDate(99, 12, 32).toISOString().slice(0, 10)).toBe("0100-01-01");
    expect(utcDate(1, 1, 0).toISOString().slice(0, 10)).toBe("0000-12-31");
  });

  test("carries no time component", () => {
    // Every caller reads a civil date off it; a stray hour would put
    // `daysBetween` off by one whenever the two endpoints disagreed.
    const at = utcDate(2026, 6, 8);
    expect([
      at.getUTCHours(),
      at.getUTCMinutes(),
      at.getUTCSeconds(),
      at.getUTCMilliseconds(),
    ]).toEqual([0, 0, 0, 0]);
  });
});
