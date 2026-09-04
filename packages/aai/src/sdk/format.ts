// Copyright 2026 the AAI authors. MIT license.
/**
 * The five formatters a workflow uses to narrate itself, and a page uses to
 * render the same run.
 *
 * They are here because both halves of a template need them and only one of
 * those halves is a Node process. A `workflows/*.ts` step calls `stepReport()` with
 * a sentence a person reads; the `client.tsx` rendering that run's output
 * writes the same sentence again. Every template that reports progress had
 * therefore grown a private copy of each — four of `mb()`, five of
 * `clock()`/`duration()`, four of `countWords()`, seventeen inline
 * `${n === 1 ? "" : "s"}`, and three incompatible money formats — split across
 * the server and browser sides of one project.
 *
 * **The duplication was already producing wrong output.** `call-audit` printed a
 * 64-minute recording as `1:04:09` from its workflow and `64:09` from its page:
 * two copies of one formatter, in one template, disagreeing about the same run.
 * {@link formatMoney} arrived the same way — `pizza-ordering` rendered
 * `$1234.00` where `travel-concierge` rendered `$1,234`, and `retail` had no
 * helper at all and spelled the format inline twelve times, so one product
 * showed a caller three conventions depending on which desk they reached.
 * That is the argument for a single implementation rather than a style
 * preference — a private copy is not merely repeated, it drifts, and nothing
 * downstream can tell which copy produced a given string.
 *
 * **They are deliberately NOT localized, and never will be.** Each returns one
 * fixed ASCII shape documented to the character on its own signature, so a spec
 * can assert the exact string and a template author can read the output format
 * without running it. `Intl.NumberFormat` and friends answer to the host's ICU
 * default, which would make the same run render differently on a developer's
 * laptop and in a sandbox — and would put a locale surface (options bags,
 * fallbacks, a `locale` parameter threaded through every call site) on helpers
 * whose entire job is one line of narration. An agent that needs localized
 * output formats it itself; that is a different feature, not a wider version of
 * this one.
 *
 * On `@alexkroman1/aai/utils` rather than the root barrel: `/utils` is the
 * subpath a browser bundle can import without pulling zod's module graph, and
 * these names are used from `client.tsx` as often as from a step.
 */

/** Ascending, each 1024x the last — the loop below walks this. */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Below this many of a unit, stay in it. */
const BYTE_STEP = 1024;

/**
 * A byte count at the scale a person reads it: `"17.7 MB"`, `"110 KB"`,
 * `"512 B"`.
 *
 * The unit is the largest one the value reaches, stepping by 1024 (`B`, `KB`,
 * `MB`, `GB`, `TB`). Bytes and kilobytes are printed as whole numbers, because
 * a tenth of a kilobyte is noise in a sentence; megabytes and up carry exactly
 * one decimal, including a trailing zero (`"2.0 MB"`), so a column of them
 * aligns and a size that grew from 2.04 to 2.4 does not read as unchanged.
 *
 * Rounding that carries into the next unit is PROMOTED rather than printed:
 * 1,048,000 bytes is `"1.0 MB"`, never `"1024 KB"`.
 *
 * A byte count is never negative and never `NaN`, so both are reported as
 * `"0 B"` rather than propagating into a sentence a caller shows a person —
 * this runs on the narration path, where the alternative is `"-0.0 MB"` in a
 * progress line.
 *
 * @example
 * ```ts
 * import { formatBytes } from "@alexkroman1/aai/utils";
 *
 * formatBytes(0); // "0 B"
 * formatBytes(112_640); // "110 KB"
 * formatBytes(18_559_795); // "17.7 MB"
 * ```
 *
 * @public
 */
export function formatBytes(bytes: number): string {
  let value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  let unit = 0;
  while (value >= BYTE_STEP && unit < BYTE_UNITS.length - 1) {
    value /= BYTE_STEP;
    unit += 1;
  }
  let text = formatByteValue(value, unit);
  // `Math.round(1023.6)` and `(1023.97).toFixed(1)` both land on 1024, which is
  // a unit that no longer exists at this scale. Step up once and reformat —
  // once is enough, because the promoted value is exactly 1.
  if (Number.parseFloat(text) >= BYTE_STEP && unit < BYTE_UNITS.length - 1) {
    unit += 1;
    text = formatByteValue(value / BYTE_STEP, unit);
  }
  return `${text} ${BYTE_UNITS[unit]}`;
}

/** Whole numbers for `B`/`KB`, one decimal from `MB` up. See {@link formatBytes}. */
function formatByteValue(value: number, unit: number): string {
  return unit <= 1 ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * A duration as a clock reading: `"4:09"` under an hour, `"1:04:09"` over one.
 *
 * Seconds are always two digits, minutes are two digits only once an hours
 * field exists, and the hours field is omitted when it is zero rather than
 * padded — so a two-minute clip reads `"2:26"` and only a long recording grows
 * a field. Input is milliseconds, rounded to the nearest second.
 *
 * **The hours field is why this is shared.** A `m:ss` formatter is four lines
 * and looks finished, so every copy of it in this repo was written that way
 * and every one of them printed a 64-minute run as `"64:09"`. That is not a
 * cosmetic difference: `64:09` reads as sixty-four minutes to a person who
 * knows the format and as an error to everyone else, and the same run's other
 * copy said `1:04:09`.
 *
 * Negative and non-finite inputs are `"0:00"` — a duration is an elapsed time,
 * and a caller subtracting two clock readings across a resume should not print
 * `"-1:-30"` into a progress line.
 *
 * @example
 * ```ts
 * import { formatDuration } from "@alexkroman1/aai/utils";
 *
 * formatDuration(0); // "0:00"
 * formatDuration(249_000); // "4:09"
 * formatDuration(3_849_000); // "1:04:09"
 * ```
 *
 * @public
 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * `$1,234.00` — an amount of money, grouped in threes and always to the cent.
 *
 * `symbol` is a PREFIX and defaults to `"$"`; pass another (`"€"`, `"£"`) to
 * change the glyph. It does not change the SHAPE, which is fixed: this is not a
 * localization seam, for the reason the module doc gives. An agent that owes a
 * caller `1.234,56 €` formats it itself.
 *
 * Always two decimal places, because the alternative drifts: a bare
 * `toLocaleString` renders `$1,234` for a round number and `$1,234.5` for a
 * change of fifty cents, so a price list rendered through it does not line up
 * and a total read aloud sounds like a different kind of number than the parts
 * that made it. Rounding is `toFixed`'s.
 *
 * The sign LEADS (`-$4.99`), which is how a refund is written. An amount that
 * rounds to zero has no sign, so a rounding error just under zero prints
 * `$0.00` rather than `-$0.00`. Non-finite is `$0.00`, matching
 * {@link formatBytes} and {@link formatDuration}.
 *
 * @example
 * ```ts
 * import { formatMoney } from "@alexkroman1/aai/utils";
 *
 * formatMoney(0); // "$0.00"
 * formatMoney(17.5); // "$17.50"
 * formatMoney(2_292.371); // "$2,292.37"
 * formatMoney(-4.99); // "-$4.99"
 * formatMoney(1_234, "€"); // "€1,234.00"
 * ```
 *
 * @public
 */
export function formatMoney(amount: number, symbol = "$"): string {
  const fixed = (Number.isFinite(amount) ? Math.abs(amount) : 0).toFixed(2);
  const dot = fixed.indexOf(".");
  // `toFixed` switches to exponential notation at 1e21, where there is no
  // integer part to group and no cent that survives float precision anyway.
  // Degraded deliberately rather than sliced into nonsense: the slicing below
  // assumes a decimal point and would answer `$1e+2` + `1` for `1e21`.
  if (dot === -1) return `${amount < 0 ? "-" : ""}${symbol}${fixed}`;
  // `\B(?=(\d{3})+$)` over the WHOLE part only: a position that is not a word
  // boundary and has a multiple of three digits after it. Slicing the cents off
  // first is what lets the pattern anchor to the end.
  const whole = fixed.slice(0, dot).replace(/\B(?=(\d{3})+$)/g, ",");
  // `Number(fixed)` rather than `amount`, so a value that ROUNDS to zero loses
  // its sign along with its magnitude.
  const sign = amount < 0 && Number(fixed) !== 0 ? "-" : "";
  return `${sign}${symbol}${whole}${fixed.slice(dot)}`;
}

/**
 * How many words a string holds — whitespace-separated runs, after trimming.
 *
 * Every kind of whitespace separates (spaces, tabs, newlines, the non-breaking
 * space a pasted transcript carries), and a run of them counts once, so a
 * transcript stitched with `"\n\n"` between segments counts the same as one
 * joined with single spaces. An empty or whitespace-only string is `0`, which
 * is the case a naive `split(/\s+/).length` gets wrong by returning `1`.
 *
 * Deliberately naive about what a "word" is: it does not know about
 * hyphenation, contractions, CJK text with no spaces in it, or numerals. It
 * exists for the one thing every template used it for — "~1,200 words" in a
 * progress line beside a transcript — where the count is a SCALE a reader
 * calibrates against, not a figure anything is computed from.
 *
 * @example
 * ```ts
 * import { countWords } from "@alexkroman1/aai/utils";
 *
 * countWords("  hello   there\nfriend "); // 3
 * countWords("   "); // 0
 * ```
 *
 * @public
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * The right form of an English noun for a count: `plural(1, "risk")` is
 * `"risk"`, `plural(2, "risk")` is `"risks"`.
 *
 * `many` defaults to `one + "s"`; pass it for a noun that does not take a bare
 * `-s` (`plural(n, "entry", "entries")`, `plural(n, "person", "people")`).
 *
 * **It returns the WORD, not the count**, because the count almost always
 * needs its own formatting on the way into the sentence — a
 * {@link formatDuration}, a thousands separator, or a word (`"no risks"`). The
 * call site writes `` `${n} ${plural(n, "risk")}` ``, which is the same shape
 * as the seventeen inline `` `${n === 1 ? "" : "s"}` `` this replaces, minus
 * the chance of pluralizing off a different variable than the one being
 * printed — which is exactly the bug that idiom hides, since both halves read
 * as noise.
 *
 * Only exactly `1` takes the singular. Zero is plural (`"0 risks"`), which is
 * English, and so is a negative or fractional count. Non-localized by
 * construction: a language with more than two forms needs a different function,
 * not an option on this one.
 *
 * @example
 * ```ts
 * import { plural } from "@alexkroman1/aai/utils";
 *
 * const risks = 3;
 * `Found ${risks} ${plural(risks, "risk")}.`; // "Found 3 risks."
 * `Read ${1} ${plural(1, "entry", "entries")}.`; // "Read 1 entry."
 * ```
 *
 * @public
 */
export function plural(n: number, one: string, many?: string): string {
  return n === 1 ? one : (many ?? `${one}s`);
}
