// Copyright 2026 the AAI authors. MIT license.
/**
 * The two properties worth pinning here are both about what these DON'T do:
 * `isIsoDate` rejects a date that matches the shape and is not a date, and the
 * arithmetic answers the same thing whatever zone the machine is in.
 */
import { describe, expect, test } from "vitest";

import { addDays, daysBetween, isClockTime, isIsoDate } from "./calendar.ts";

describe("isIsoDate", () => {
  test("accepts a real date", () => {
    expect(isIsoDate("2026-06-08")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true); // a leap day
  });

  test("rejects a date that matches the SHAPE but is not a date", () => {
    // The whole reason this is a function rather than a regex at each call
    // site: a desk that took February 30th booked a stay it could not honour.
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2025-02-29")).toBe(false); // not a leap year
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-00-10")).toBe(false);
  });

  test("rejects anything that is not YYYY-MM-DD", () => {
    for (const value of ["6/8/2026", "2026-6-8", "2026-06-08T00:00:00Z", "", "tomorrow"]) {
      expect(isIsoDate(value)).toBe(false);
    }
  });
});

describe("isClockTime", () => {
  test("accepts a zero-padded 24-hour time", () => {
    for (const value of ["00:00", "04:45", "19:30", "23:59"]) {
      expect(isClockTime(value)).toBe(true);
    }
  });

  test("rejects an unpadded hour", () => {
    // Padding is required because "9:05" and "09:05" sort differently, so a
    // desk storing whichever the model produced cannot compare its own rows.
    expect(isClockTime("9:05")).toBe(false);
  });

  test("rejects out-of-range and over-precise values", () => {
    for (const value of ["24:00", "19:60", "19:30:00", "7 PM", ""]) {
      expect(isClockTime(value)).toBe(false);
    }
  });
});

describe("addDays", () => {
  test("adds and subtracts calendar days", () => {
    expect(addDays("2026-06-08", 3)).toBe("2026-06-11");
    expect(addDays("2026-06-08", 0)).toBe("2026-06-08");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  test("crosses month and leap-year boundaries", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("refuses a value that is not a date rather than answering", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
  });
});

describe("daysBetween", () => {
  test("counts NIGHTS — the same day is zero", () => {
    expect(daysBetween("2026-06-08", "2026-06-11")).toBe(3);
    expect(daysBetween("2026-06-08", "2026-06-08")).toBe(0);
  });

  test("is signed", () => {
    expect(daysBetween("2026-06-11", "2026-06-08")).toBe(-3);
  });

  test("counts across a DST transition as calendar days", () => {
    // The reason the arithmetic goes through `Date.UTC`: US DST starts on
    // 2026-03-08, so a local-time subtraction here answers 0.958…, which
    // rounds to 1 by luck rather than by construction.
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
  });

  test("refuses either endpoint not being a date", () => {
    expect(() => daysBetween("nope", "2026-06-08")).toThrow(RangeError);
    expect(() => daysBetween("2026-06-08", "nope")).toThrow(RangeError);
  });
});
