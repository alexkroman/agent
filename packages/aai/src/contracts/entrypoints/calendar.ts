// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `calendar`.
 *
 * Civil dates and clock times — the strings a voice agent's tool arguments
 * carry, the predicates that say whether one is real, the two pieces of
 * arithmetic on them, and the zod fields that declare the rule where the MODEL
 * reads it.
 *
 * Its own capability rather than part of `utils` or `spoken`, because what it
 * promises is a CALENDAR reading and not a signature: `isIsoDate` refusing
 * `2026-02-30`, `daysBetween` counting nights rather than days, and both
 * answering the same thing in every time zone. A change that made any of those
 * merely convenient would keep every type here and break every caller.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export { addDays, clockTime, daysBetween, isClockTime, isIsoDate, isoDate } from "../../index.ts";
