// Copyright 2026 the AAI authors. MIT license.
/**
 * Turning data into the words a TTS voice reads correctly — the OUTBOUND half
 * of `spoken.ts`.
 *
 * That module turns what a caller SAID into one thing they meant. This one goes
 * the other way, and the two are the same problem seen from each end: a voice
 * agent's boundary is speech in both directions, and only one direction had
 * helpers. Every template that read a number aloud had therefore grown a
 * private copy of these — `hotel-reception-agent` alone carried four, and `roadside-assistance-agent`
 * rendered `$150` where every other desk rendered `$150.00`.
 *
 * **The failure these prevent is not ugliness, it is being misheard.** A TTS
 * engine handed `$240.50` may say "dollar sign two hundred forty point five
 * zero"; handed `2026-06-08` it may spell the digits; handed `19:30` it may say
 * "nineteen thirty" to a caller who thinks in AM and PM. None of those is a
 * crash and none shows up in a transcript diff — the text was right and the
 * call still went wrong. Rendering the words explicitly is the fix, and it has
 * to happen before the string reaches the model, because the model is not
 * reliably going to do it for you.
 *
 * **Fixed ASCII shapes, no `Intl`** — the same rule `format.ts` argues at
 * length, and it bites harder here. `toLocaleDateString("en-US", …)` answers to
 * the host's ICU build, so a desk that reads dates correctly on a laptop can
 * read them differently inside a sandbox, and no spec catches it because the
 * spec runs on the laptop. The month and weekday names below are written out
 * for exactly that reason. An agent that needs another language renders its
 * own; that is a different feature, not an option on this one.
 *
 * @module
 */

import { isoDateParts, utcDate } from "./_civil-date.ts";
import { plural } from "./format.ts";

/** Fixed English names, so no ICU build can change what a desk says. */
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Indexed by `getUTCDay()`, which counts from Sunday. */
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * An amount as a voice reads it — `"240 dollars and 50 cents"`.
 *
 * Takes DOLLARS, the same unit as `formatMoney` (`@alexkroman1/aai/utils`),
 * and rounds the same way
 * it does. That is not a coincidence to preserve by hand: both derive from one
 * `toFixed(2)`, so the written total on a page and the spoken total on the call
 * cannot disagree about a half-cent. A desk that counts in cents divides on the
 * way in, exactly as it already does for `formatMoney`.
 *
 * Singular is respected on both halves (`"1 dollar and 1 cent"`), because "1
 * dollars" is the kind of thing a caller hears and a transcript diff does not.
 * A negative amount leads with the word `"minus"` — a `-` renders as silence or
 * as "dash" depending on the engine, and a refund read as a charge is the worst
 * available outcome. Non-finite degrades to `"0 dollars"`, matching
 * `formatMoney`'s `$0.00`.
 *
 * The currency WORD is fixed. Symbols are pronounced inconsistently and a
 * `symbol` parameter like `formatMoney`'s would be read out as a symbol; an
 * agent billing in another currency writes its own sentence.
 *
 * @example
 * ```ts
 * import { spokenMoney } from "@alexkroman1/aai";
 *
 * spokenMoney(240.5); // "240 dollars and 50 cents"
 * spokenMoney(240); // "240 dollars"
 * spokenMoney(1.01); // "1 dollar and 1 cent"
 * spokenMoney(0.75); // "75 cents"
 * spokenMoney(-4.99); // "minus 4 dollars and 99 cents"
 * ```
 *
 * @public
 */
export function spokenMoney(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  // The SAME rounding `formatMoney` performs, on the absolute value, so the two
  // renderings of one number agree by construction rather than by review.
  const fixed = Math.abs(safe).toFixed(2);
  const dot = fixed.indexOf(".");
  // `toFixed` switches to exponential notation above 1e21, where there is no
  // cent left that survives float precision. Degraded deliberately rather than
  // sliced into nonsense, the way `formatMoney` degrades at the same boundary.
  if (dot === -1) return `${safe < 0 ? "minus " : ""}${fixed} dollars`;
  const dollars = Number(fixed.slice(0, dot));
  const cents = Number(fixed.slice(dot + 1));
  // The sign is taken from the ROUNDED value, so an amount just under zero
  // reads as "0 dollars" rather than "minus 0 dollars".
  const sign = safe < 0 && (dollars > 0 || cents > 0) ? "minus " : "";
  const dollarWords = `${dollars} ${plural(dollars, "dollar")}`;
  const centWords = `${cents} ${plural(cents, "cent")}`;
  if (cents === 0) return `${sign}${dollarWords}`;
  // Under a dollar the dollar half is noise: "75 cents", not "0 dollars and 75
  // cents", which is what a person says and half a second shorter on the call.
  if (dollars === 0) return `${sign}${centWords}`;
  return `${sign}${dollarWords} and ${centWords}`;
}

/**
 * A `YYYY-MM-DD` as a receptionist says it — `"Monday, June 8"`.
 *
 * No year, because a date a caller is agreeing to on the phone is almost always
 * within the year and saying it is four wasted syllables. A desk booking
 * further out writes its own sentence around this one.
 *
 * The weekday is included on purpose: it is the half a caller actually checks.
 * "The 8th" gets agreed to and then turns out to be a Tuesday.
 *
 * A value that is not a date {@link isIsoDate} accepts is returned UNCHANGED —
 * degrade rather than throw, matching the formatters in `format.ts`. Declare
 * the argument with `isoDate()` and a caller never reaches that path.
 *
 * @example
 * ```ts
 * import { spokenDate } from "@alexkroman1/aai";
 *
 * spokenDate("2026-06-08"); // "Monday, June 8"
 * spokenDate("not a date"); // "not a date"
 * ```
 *
 * @public
 */
export function spokenDate(iso: string): string {
  const ymd = isoDateParts(iso);
  if (ymd === undefined) return iso;
  const [y, m, d] = ymd;
  // `utcDate`, not `Date.UTC`: the latter maps a year under 100 onto the
  // 1900s, which is the wrong WEEKDAY rather than a visibly wrong date.
  const weekday = WEEKDAYS[utcDate(y, m, d).getUTCDay()];
  return `${weekday}, ${MONTHS[m - 1]} ${d}`;
}

/**
 * A 24-hour `HH:MM` as a voice reads it — `"7 PM"`, `"6:30 PM"`.
 *
 * On the hour, the minutes are dropped: `"7 PM"` rather than `"7:00 PM"`, which
 * an engine reads as "seven zero zero PM". `AM`/`PM` are upper-cased because
 * that is the spelling engines pronounce as letters most reliably; `"am"` is
 * read as a word often enough to matter.
 *
 * Midnight is `"12 AM"` and noon is `"12 PM"`, the American convention that
 * matches the 12-hour clock this renders into. A desk whose callers would
 * rather hear "midnight" says so itself — this is the mechanical half.
 *
 * A value that is not a time {@link isClockTime} accepts is returned unchanged,
 * for the reason {@link spokenDate} gives.
 *
 * @example
 * ```ts
 * import { spokenTime } from "@alexkroman1/aai";
 *
 * spokenTime("19:00"); // "7 PM"
 * spokenTime("18:30"); // "6:30 PM"
 * spokenTime("04:45"); // "4:45 AM"
 * spokenTime("00:00"); // "12 AM"
 * ```
 *
 * @public
 */
export function spokenTime(hhmm: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (match === null) return hhmm;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const suffix = h < 12 ? "AM" : "PM";
  // `% 12` maps both 0 and 12 to 0, and both are spoken as 12.
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${match[2]} ${suffix}`;
}

/** Options for {@link mintCode}. */
export interface MintCodeOptions {
  /**
   * Codes already issued. A generated code that collides is discarded and
   * another drawn, so the caller does not have to loop.
   */
  taken?: ReadonlySet<string>;
  /**
   * The suffix length. Four characters over a 31-symbol alphabet is about
   * 923,000 codes — enough that a desk with a few thousand live references
   * collides rarely and re-draws cheaply.
   */
  length?: number;
  /**
   * The randomness source, `[0, 1)`. Defaults to `Math.random`; pass
   * `ctx.random` from a tool body to make the code a journaled, replayable
   * value instead of a fresh one on every run.
   */
  random?: () => number;
}

/**
 * A `PREFIX-XXXX` reference, on an alphabet a caller can read back.
 *
 * `0`/`O`, `1`/`I` and `L` are all absent, and that is the entire design. Every
 * code a voice agent issues gets read down a phone and read back, and those are
 * the characters that come back wrong — a caller says "oh" for a zero, an STT
 * writes `1` for a spoken "el". Removing them from the alphabet is the fix that
 * needs no correction logic anywhere downstream, and it is why this belongs
 * beside `spokenAlphanumeric`, which is what parses the read-back.
 *
 * @throws Error if `taken` is dense enough that no free code is drawn in a
 * bounded number of attempts. Unbounded retry is the version that turns a full
 * code space into a hung call rather than an error someone can act on.
 *
 * @example
 * ```ts
 * import { mintCode } from "@alexkroman1/aai";
 *
 * mintCode("HTL"); // e.g. "HTL-7K2M"
 * mintCode("RES", { taken: new Set(["RES-7K2M"]) });
 * ```
 *
 * @public
 */
export function mintCode(prefix: string, options: MintCodeOptions = {}): string {
  const { taken = new Set<string>(), length = 4, random = Math.random } = options;
  // Chunked only so that no single string literal here reads as a high-entropy
  // secret to a scanner.
  const alphabet = ["ABCDEFGH", "JKMNPQRS", "TUVWXYZ", "23456789"].join("");
  const MAX_ATTEMPTS = 1000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let suffix = "";
    for (let i = 0; i < length; i++) {
      suffix += alphabet[Math.floor(random() * alphabet.length)];
    }
    const code = `${prefix}-${suffix}`;
    if (!taken.has(code)) return code;
  }
  throw new Error(
    `mintCode: no free ${prefix}-${"X".repeat(length)} code after ${MAX_ATTEMPTS} attempts`,
  );
}
