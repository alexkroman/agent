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
 * The three numbers of an ISO date, or `undefined` if it is not one.
 *
 * The real-calendar check is the round-trip: `Date.UTC` NORMALIZES out of range
 * rather than rejecting, so `2026-02-30` becomes March 2nd and the day no
 * longer matches. That is the check a bare regex cannot make, and the reason
 * both callers go through here rather than testing the pattern themselves.
 */
export function isoDateParts(iso: string): [number, number, number] | undefined {
  if (!ISO_DATE_SHAPE.test(iso)) return undefined;
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  // `Date.UTC` maps a year of 0-99 onto 1900-1999 — legacy two-digit-year
  // behaviour that `setUTCFullYear` does not have. Without this, `0001-01-01`
  // round-trips as 1901 and a shape-valid date is rejected for a reason nothing
  // states. No voice agent will see a year like that; the point is that the
  // predicate's answer matches what its own doc promises.
  if (y >= 0 && y <= 99) at.setUTCFullYear(y);
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) {
    return undefined;
  }
  return [y, m, d];
}
