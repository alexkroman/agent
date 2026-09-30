// Copyright 2026 the AAI authors. MIT license.
/**
 * `normalizePhone` — a phone number someone said or typed, as E.164.
 *
 * The same rule the runtime applies to a client's `?phone=`
 * (`normalizeE164` in `session-phone.ts`: formatting stripped, `+` and 8–15
 * digits) plus the one assumption a tool may choose to make and the runtime
 * must not: that a number said WITHOUT a country code is in the caller's own
 * country. That is opt-in, per call, because it is a guess — a desk in Austin
 * hearing "five one two, five five five…" is right to assume +1, and an agent
 * serving anywhere is not.
 *
 * Only the North American Numbering Plan (`"US"`, `"CA"`, both `+1`) is
 * supported as a default country: it is the one plan where "a national number"
 * is a fixed ten digits with no trunk prefix to strip, so the guess is exact.
 *
 * @module phone
 */

import { normalizeE164 } from "./session-phone.ts";

/**
 * What {@link normalizePhone} takes.
 *
 * @public
 */
export interface NormalizePhoneOptions {
  /**
   * The country a number WITHOUT a `+` is assumed to be in. `"US"` and `"CA"`
   * (North America, `+1`): ten digits, or eleven starting with `1`. Unset, a
   * number without its `+` is refused rather than guessed at.
   */
  defaultCountry?: "US" | "CA";
}

/** A NANP national number: area code and exchange each start 2–9. */
const NANP_RE = /^1?([2-9]\d{2}[2-9]\d{6})$/;

/**
 * `raw` as an E.164 number (`"+15125550123"`), or `undefined` when it is not
 * one. Spaces, dashes, dots and parentheses are formatting and are stripped.
 * With `defaultCountry`, a number said without its country code is read in
 * that country's plan.
 *
 * @example
 * ```ts
 * import { normalizePhone } from "@alexkroman1/aai/utils";
 *
 * normalizePhone("+44 20 7946 0958"); // "+442079460958"
 * normalizePhone("(512) 555-0123"); // undefined — no country code, no guess
 * normalizePhone("(512) 555-0123", { defaultCountry: "US" }); // "+15125550123"
 * ```
 *
 * @public
 */
export function normalizePhone(
  raw: string,
  options: NormalizePhoneOptions = {},
): string | undefined {
  const e164 = normalizeE164(raw.trim());
  if (e164 !== undefined || options.defaultCountry === undefined) return e164;
  const digits = raw.trim().replace(/[\s().-]/g, "");
  const national = NANP_RE.exec(digits)?.[1];
  return national === undefined ? undefined : `+1${national}`;
}
