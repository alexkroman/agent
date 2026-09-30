// Copyright 2026 the AAI authors. MIT license.
/**
 * `phoneE164` — a number as a person types it, in the E.164 form
 * `VoiceSessionOptions.phone` must carry, or `undefined` when it cannot be
 * one. The server strips punctuation too, but DROPS a number with no `+`
 * country code (guessing one would text a stranger), so a settings field that
 * accepts `(503) 555-0123` must say which country it means — this is where it
 * says so, and where a page can tell the user the number will not be used
 * before a connect silently ignores it.
 *
 * @module
 */

/**
 * Options for {@link phoneE164}.
 *
 * @public
 */
export type PhoneE164Options = {
  /**
   * The country calling code to assume for a number typed WITHOUT one — `"1"`
   * for the US and Canada, `"44"` for the UK. Without it, only a number that
   * already starts with `+` (or the `00` international prefix) is accepted.
   *
   * With `"1"`, a 10-digit number takes `+1`, and an 11-digit one starting
   * with `1` is taken as already carrying it. With any other code, one leading
   * trunk `0` is dropped before the code is prepended (`020 7946 0958` with
   * `"44"` is `+442079460958`).
   */
  countryCode?: string | undefined;
};

/** Spaces, dashes, dots and brackets — the punctuation people type in a number. */
const PUNCTUATION = /[\s\-.()]/g;
/** E.164: `+`, then 8 to 15 digits (the server's own rule). */
const E164 = /^\+\d{8,15}$/;

/**
 * The phone number `typed` in E.164 form (`"+15035550123"`), or `undefined`
 * when it cannot be one — see {@link PhoneE164Options} for how a number
 * without a country code is read.
 *
 * @example The session's phone, from a stored setting, assuming North America
 * ```ts
 * import { mountClient, phoneE164 } from "@alexkroman1/aai-ui";
 *
 * declare function storedPhone(): string;
 *
 * mountClient({ phone: () => phoneE164(storedPhone(), { countryCode: "1" }) });
 * ```
 *
 * @param typed - The number as entered.
 * @param options - The country to assume; see {@link PhoneE164Options}.
 * @returns The E.164 number, or `undefined`.
 *
 * @public
 */
export function phoneE164(typed: string, options: PhoneE164Options = {}): string | undefined {
  const raw = typed.replace(PUNCTUATION, "");
  const code = options.countryCode?.replace(/^\+/, "");
  let e164 = raw;
  if (raw.startsWith("00")) e164 = `+${raw.slice(2)}`;
  else if (raw.startsWith("+") || !code || !/^\d{1,3}$/.test(code)) e164 = raw;
  else if (code === "1") {
    // North America's national numbers are exactly ten digits; anything else
    // under an assumed `+1` is a typo, not a number to text.
    const national = /^1\d{10}$/.test(raw) ? raw.slice(1) : raw;
    if (!/^\d{10}$/.test(national)) return undefined;
    e164 = `+1${national}`;
  } else e164 = `+${code}${raw.replace(/^0/, "")}`;
  return E164.test(e164) ? e164 : undefined;
}
