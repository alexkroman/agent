// Copyright 2026 the AAI authors. MIT license.
/**
 * The two properties worth pinning here are both about what these DON'T do:
 * `isIsoDate` rejects a date that matches the shape and is not a date, and the
 * arithmetic answers the same thing whatever zone the machine is in.
 */
import fc from "fast-check";
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

/**
 * The properties, and why they are properties.
 *
 * The two-digit-year bug — `Date.UTC` mapping years 0-99 onto 1900-1999, so
 * `0001-01-01` round-tripped as 1901 and was refused — got past the hand-written
 * table above. It was found by happening to type a one-digit year, which is
 * exactly the boundary a generator finds and a table does not.
 *
 * These are VALUE-LEVEL properties, so they carry no coverage floor and should
 * not: a counter over `fc.date()` draws would be an assertion about
 * fast-check's own distribution. The remedy for vacuity here is another
 * property, which is why the boundaries each get named out loud below rather
 * than being left to the generator.
 */
describe("calendar properties", () => {
  /** Any real calendar date, as the `YYYY-MM-DD` these functions take. */
  /**
   * Any real calendar date, as the `YYYY-MM-DD` these functions take.
   *
   * The bounds are PARSED, not built with `Date.UTC` — which was the first
   * draft and put the floor at 1901, so the arbitrary excluded exactly the
   * two-digit years these properties exist to cover. The trap catches the test
   * as readily as the code.
   */
  const isoDates = fc
    .date({
      min: new Date("0000-01-01T00:00:00.000Z"),
      max: new Date("9999-12-31T00:00:00.000Z"),
      noInvalidDate: true,
    })
    .map((at) => at.toISOString().slice(0, 10));

  test("every date fc.date can produce is one isIsoDate accepts", () => {
    // The claim the two-digit-year bug broke: the predicate's answer matches
    // its documentation ("years are taken as written") across the whole range,
    // not just the years a voice agent will see.
    fc.assert(
      fc.property(isoDates, (iso) => {
        expect(isIsoDate(iso)).toBe(true);
      }),
    );
  });

  test("addDays always lands on a date", () => {
    // The offset is derived from a SECOND date rather than drawn independently,
    // so the result is inside the representable calendar by construction. Drawn
    // independently this found the expanded-year bug `addDays` now refuses —
    // see the named boundary below, which keeps that case covered.
    fc.assert(
      fc.property(isoDates, isoDates, (from, to) => {
        expect(isIsoDate(addDays(from, daysBetween(from, to)))).toBe(true);
      }),
    );
  });

  test("addDays and daysBetween invert each other, both ways round", () => {
    // The round-trip. It is what makes the pair usable for a stay's night count
    // at all: an off-by-one in either would show here for some offset.
    fc.assert(
      fc.property(isoDates, isoDates, (from, to) => {
        expect(addDays(from, daysBetween(from, to))).toBe(to);
      }),
    );
    fc.assert(
      fc.property(isoDates, fc.integer({ min: -300_000, max: 300_000 }), (iso, days) => {
        // Skipped rather than forced where the offset leaves the calendar: the
        // property is about the inverse, and the boundary has its own test.
        let shifted: string;
        try {
          shifted = addDays(iso, days);
        } catch {
          return;
        }
        expect(daysBetween(iso, shifted)).toBe(days);
      }),
    );
  });

  test("addDays composes", () => {
    fc.assert(
      fc.property(
        isoDates,
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        (iso, a, b) => {
          let stepwise: string;
          let direct: string;
          try {
            stepwise = addDays(addDays(iso, a), b);
            direct = addDays(iso, a + b);
          } catch {
            return;
          }
          expect(stepwise).toBe(direct);
        },
      ),
    );
  });

  test("addDays refuses an offset that leaves the representable calendar", () => {
    // The bug the property found: `toISOString` switches to `+010000-01-01T…`
    // past year 9999, so a 10-character slice used to answer `"+010000-01"` —
    // not a date, and nothing downstream would have questioned it.
    expect(() => addDays("9719-04-15", 102_529)).toThrow(/outside the years 0000-9999/);
    // And the last day that IS representable still works.
    expect(addDays("9999-12-30", 1)).toBe("9999-12-31");
  });

  test("daysBetween is antisymmetric, and zero only on the same day", () => {
    fc.assert(
      fc.property(isoDates, isoDates, (from, to) => {
        // Summed rather than compared against a negation: `-0` and `0` are
        // distinct under `Object.is`, so the same-day case failed a `toBe`
        // against `-daysBetween(...)` while being perfectly antisymmetric.
        expect(daysBetween(from, to) + daysBetween(to, from)).toBe(0);
        expect(daysBetween(from, to) === 0).toBe(from === to);
      }),
    );
  });

  test("a two-digit year is handled by every function, not just the predicate", () => {
    // `Date.UTC(1, 0, 1)` is 1901, not year 1. The correction first landed in
    // `isoDateParts` alone, so `isIsoDate` accepted these while `addDays`,
    // `daysBetween` and `spokenDate` each built their own uncorrected
    // `Date.UTC` and answered in the 1900s — `addDays("0001-01-01", 1)` was
    // `"1901-01-02"`. Every one of them is asserted here because a per-site
    // correction is exactly the shape that leaves three of four sites wrong.
    expect(isIsoDate("0001-01-01")).toBe(true);
    expect(isIsoDate("0099-12-31")).toBe(true);
    expect(addDays("0001-01-01", 1)).toBe("0001-01-02");
    expect(addDays("0099-12-31", 1)).toBe("0100-01-01");
    expect(daysBetween("0001-01-01", "0001-01-02")).toBe(1);
    expect(daysBetween("0001-01-01", "0100-01-01")).toBe(36_159);
  });

  test("the year 0 and the far end are dates too", () => {
    expect(isIsoDate("0000-01-01")).toBe(true);
    expect(isIsoDate("9999-12-31")).toBe(true);
  });
});
