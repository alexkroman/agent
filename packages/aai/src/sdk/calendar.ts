// Copyright 2026 the AAI authors. MIT license.
/**
 * Plain calendar dates and clock times — the strings a voice agent's tool
 * arguments actually carry.
 *
 * A date reaches a tool as `"2026-06-08"` and a time as `"19:30"`, because that
 * is the one shape a model reliably produces when the prompt asks for it. Both
 * are CIVIL values: "the 8th of June", not an instant. Nothing here converts
 * either to a timestamp, and that is the point — the moment a `YYYY-MM-DD`
 * becomes a `Date` in the host's zone, "checkout on the 8th" is off by a day
 * for half the planet, and the bug only shows up on a machine configured
 * differently from the author's.
 *
 * So the arithmetic below goes through `Date.UTC` and comes straight back out
 * as a string. UTC is not a claim about where anyone is; it is the only zone
 * with no DST, which makes `addDays` add days rather than sometimes 23 or 25
 * hours.
 *
 * **`isIsoDate` is a real calendar check, not a shape check.** `2026-02-30`
 * matches the pattern and is not a date. That distinction is the whole reason
 * this is a function rather than a regex at each call site: a desk that accepted
 * February 30th booked a stay it could never honour, and the failure surfaced
 * as a nonsense night count rather than as a rejected argument.
 *
 * The predicates pair with the zod fields in `tool-fields.ts`, which is how a
 * tool should reach them: declared on the schema, the rule is JSON Schema the
 * model can read and a rejection `parseToolInput` makes before `execute` runs.
 *
 * @module
 */

import { isoDateParts } from "./_civil-date.ts";

/** 24-hour `HH:MM`. Anchored, so `"9:30"` and `"19:30:00"` are both refused. */
const CLOCK_TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * `YYYY-MM-DD`, and a real calendar date — `2026-02-30` is refused.
 *
 * Years are taken as written, so `0000-01-01` is a date. Nothing here decides
 * whether a date is in a range an agent should accept; a stay in 1823 is the
 * desk's question, not this one's.
 *
 * @example
 * ```ts
 * import { isIsoDate } from "@alexkroman1/aai";
 *
 * isIsoDate("2026-06-08"); // true
 * isIsoDate("2026-02-30"); // false — February has no 30th
 * isIsoDate("6/8/2026"); // false
 * ```
 *
 * @public
 */
export function isIsoDate(value: string): boolean {
  return isoDateParts(value) !== undefined;
}

/**
 * 24-hour `HH:MM`, zero-padded — `"09:05"` yes, `"9:05"` no.
 *
 * The padding requirement is deliberate rather than strict for its own sake:
 * `"9:05"` and `"09:05"` sort differently as strings, and a desk that stores
 * whichever the model produced cannot compare two of its own appointments.
 *
 * @example
 * ```ts
 * import { isClockTime } from "@alexkroman1/aai";
 *
 * isClockTime("19:30"); // true
 * isClockTime("04:45"); // true
 * isClockTime("4:45"); // false — not zero-padded
 * isClockTime("24:00"); // false — midnight is 00:00
 * ```
 *
 * @public
 */
export function isClockTime(value: string): boolean {
  return CLOCK_TIME_SHAPE.test(value);
}

/**
 * `iso` plus `days`, as another `YYYY-MM-DD`. Negative `days` goes backwards.
 *
 * Computed in UTC, so it adds calendar days and no machine's zone can move the
 * answer. Month and year boundaries are the `Date.UTC` normalization's, so
 * `addDays("2026-02-28", 1)` is March 1st in a common year and February 29th in
 * a leap one without either case being written here.
 *
 * @throws RangeError if `iso` is not a date {@link isIsoDate} accepts. Arithmetic
 * on a value that is not a date has no right answer, and a silently wrong one
 * becomes a booking — declare the argument with `isoDate()` and this cannot
 * happen.
 *
 * @example
 * ```ts
 * import { addDays } from "@alexkroman1/aai";
 *
 * addDays("2026-06-08", 3); // "2026-06-11"
 * addDays("2026-01-01", -1); // "2025-12-31"
 * ```
 *
 * @public
 */
export function addDays(iso: string, days: number): string {
  const ymd = isoDateParts(iso);
  if (ymd === undefined) throw new RangeError(`addDays: ${iso} is not a YYYY-MM-DD date`);
  const [y, m, d] = ymd;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `from` to `to` — a stay's night count.
 *
 * Signed: a `to` before `from` is negative. Same day is `0`, which is what
 * makes it a NIGHT count rather than a day count, and is the reading a hotel,
 * a car rental and a subscription all want.
 *
 * @throws RangeError if either argument is not a date {@link isIsoDate} accepts.
 *
 * @example
 * ```ts
 * import { daysBetween } from "@alexkroman1/aai";
 *
 * daysBetween("2026-06-08", "2026-06-11"); // 3
 * daysBetween("2026-06-08", "2026-06-08"); // 0
 * daysBetween("2026-06-11", "2026-06-08"); // -3
 * ```
 *
 * @public
 */
export function daysBetween(from: string, to: string): number {
  const a = isoDateParts(from);
  const b = isoDateParts(to);
  if (a === undefined) throw new RangeError(`daysBetween: ${from} is not a YYYY-MM-DD date`);
  if (b === undefined) throw new RangeError(`daysBetween: ${to} is not a YYYY-MM-DD date`);
  const MS_PER_DAY = 86_400_000;
  // Both endpoints are midnight UTC, so the difference is an exact multiple of
  // a day and the rounding only absorbs float noise at extreme years.
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / MS_PER_DAY);
}
