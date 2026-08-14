// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `spoken`.
 *
 * Turning what a caller SAID into one of the things a tool holds: digits and
 * positions read out of an utterance, and the pick-exactly-one contract whose
 * whole point is that ambiguity is an answer rather than a guess.
 *
 * Its own capability rather than part of `utils`, because it is a promise about
 * BEHAVIOUR and not only about a signature: an agent built on it relies on a
 * miss and a tie both coming back as a `ToolFailure` that lists the candidates.
 * A change that merely resolved a tie would keep every type in this file and
 * break every caller.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export { type ResolveOneOptions, resolveOne, spokenDigits, spokenOrdinal } from "../../index.ts";
