// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool-argument fields whose rule the model should READ rather than discover.
 *
 * A voice agent's tools keep asking for the same handful of shapes — a date, a
 * clock time — and the shape kept being declared twice: once as
 * `z.string().describe("YYYY-MM-DD")`, which is advice, and once as an
 * `if (!isIsoDate(...)) return toolFailure(...)` in the body, which is the
 * actual rule. `hotel-reception-agent` had ten of those pairs with four different
 * sentences for one constraint, plus five hand-rolled `HH:MM` checks in three
 * wordings and two different failure shapes.
 *
 * **The duplication is not the interesting part; WHERE the rule lives is.** A
 * check in the body runs after the model has already committed to an argument,
 * so the model learns the format by being refused — a wasted turn on every
 * call, and a refusal sentence the author had to write. Declared on the schema,
 * the same rule reaches the model as JSON Schema before it calls anything, and
 * `parseToolInput` rejects a bad value before `execute` runs.
 *
 * Each field takes what it is FOR, so the description and the rejection both
 * name the argument: `isoDate("the arrival date")` rather than a generic
 * sentence a caller has to map back onto one of four date parameters.
 *
 * These are ordinary zod schemas — chain `.optional()`, `.default()` or a
 * further `.refine()` onto them the way you would any other.
 *
 * @module
 */

import { z } from "zod";
import { isClockTime, isIsoDate } from "./calendar.ts";

/**
 * A calendar date argument: `YYYY-MM-DD`, and a real date.
 *
 * `refine(isIsoDate)` rather than zod's own `z.iso.date()`, so that the
 * predicate an agent's own code calls and the rule its schema enforces are one
 * definition and cannot disagree — `z.iso.date()` accepts `2026-02-30`, which
 * {@link isIsoDate} refuses.
 *
 * @param what - The argument, named as the model and the caller should hear it
 * (`"the arrival date"`). Reaches the model in the description and the caller
 * in the rejection.
 *
 * @example
 * ```ts
 * import { isoDate, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Book a spa appointment.",
 *   inputSchema: z.object({
 *     date: isoDate("the appointment date"),
 *     guest: z.string().min(1),
 *   }),
 *   execute: (args) => ({ booked: args.date }),
 * });
 * ```
 *
 * @public
 */
export function isoDate(what = "the date"): z.ZodString {
  return z
    .string()
    .refine(isIsoDate, { error: `${what} must be a real date in YYYY-MM-DD form` })
    .describe(`${what}, YYYY-MM-DD`);
}

/**
 * A time-of-day argument: 24-hour `HH:MM`, zero-padded.
 *
 * The description states the padding with an example, because that is the half
 * a model gets wrong — it produces `"4:45"` for "quarter to five in the
 * morning" unless told, and an unpadded time sorts wrong against a padded one
 * stored earlier.
 *
 * @param what - The argument, named as the model and the caller should hear it
 * (`"the pickup time"`).
 *
 * @example
 * ```ts
 * import { clockTime, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Schedule a wake-up call.",
 *   inputSchema: z.object({ time: clockTime("the wake-up time") }),
 *   execute: (args) => ({ at: args.time }),
 * });
 * ```
 *
 * @public
 */
export function clockTime(what = "the time"): z.ZodString {
  return z
    .string()
    .refine(isClockTime, { error: `${what} must be a 24-hour HH:MM time, like 19:30 or 04:45` })
    .describe(`${what}, 24-hour HH:MM — 4:45 a.m. is 04:45`);
}
