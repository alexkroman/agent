// Copyright 2026 the AAI authors. MIT license.
/**
 * The one ISO-date parse `calendar.ts` and `spoken-render.ts` share.
 *
 * Its own internal module rather than an export of either: both need the parsed
 * triple, and a `@internal`-tagged export on a public barrel is still in an
 * author's autocomplete — which `check:api-contracts` refuses, correctly.
 *
 * @module _civil-date
 */

/** `YYYY-MM-DD`, as a shape. Whether it is a real date is {@link isoDateParts}'. */
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A UTC midnight for a civil year/month/day, with `Date.UTC`'s two-digit-year
 * trap closed.
 *
 * **`Date.UTC` maps a year of 0-99 onto 1900-1999** — legacy behaviour
 * `setUTCFullYear` does not have. Every function that turns a `YYYY-MM-DD` into
 * a `Date` therefore has to correct it, and this is the one place that does.
 *
 * That single home is the fix rather than an implementation detail. The
 * correction first landed in {@link isoDateParts} alone, so `isIsoDate` accepted
 * `0001-01-01` while `addDays`, `daysBetween` and `spokenDate` each built their
 * own uncorrected `Date.UTC` and silently answered in the 1900s —
 * `addDays("0001-01-01", 1)` was `"1901-01-02"`. A per-call-site correction is
 * exactly the shape that leaves three of four sites wrong, which is why this
 * takes the numbers rather than exporting the rule.
 *
 * `month` is 1-based, unlike `Date.UTC`'s: every caller here holds a month off
 * an ISO string, and the `- 1` was the other thing being repeated.
 */
export function utcDate(year: number, month: number, day: number): Date {
  // Built in two steps, and the ORDER is the whole point. Correcting the year
  // after `Date.UTC(year, month - 1, day)` is too late whenever `day` is out of
  // range: `utcDate(99, 12, 32)` computes 1999-12-32 -> 2000-01-01, and setting
  // the year to 99 on THAT leaves 0099-01-01 — a full year wrong, from a fix
  // that looked right. So the year is set first, through `setUTCFullYear`
  // (which has no two-digit mapping), and the day is normalized afterwards
  // inside the era it belongs to.
  const at = new Date(0);
  at.setUTCHours(0, 0, 0, 0);
  at.setUTCFullYear(year, month - 1, 1);
  at.setUTCDate(day);
  return at;
}

/**
 * The three numbers of an ISO date, or `undefined` if it is not one.
 *
 * The real-calendar check is the round-trip: `Date.UTC` NORMALIZES out of range
 * rather than rejecting, so `2026-02-30` becomes March 2nd and the day no
 * longer matches. That is the check a bare regex cannot make, and the reason
 * every caller goes through here rather than testing the pattern themselves.
 */
export function isoDateParts(iso: string): [number, number, number] | undefined {
  if (!ISO_DATE_SHAPE.test(iso)) return undefined;
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const at = utcDate(y, m, d);
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) {
    return undefined;
  }
  return [y, m, d];
}
