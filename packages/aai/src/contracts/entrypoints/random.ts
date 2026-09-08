// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `random`.
 *
 * Randomness over a SOURCE rather than the global — the three shapes a tool
 * body wants, plus the seeded generator `createToolContext` defaults to.
 *
 * `ToolContext.random` is what makes these worth a capability: the promise is
 * that a tool's randomness is an ARGUMENT, so a spec can state what a tool drew
 * rather than bound it. `randomInt` clamping a source that returns exactly 1,
 * `pickOne` answering `undefined` for an empty list rather than throwing, and
 * `shuffled` copying rather than mutating are each behaviour a signature cannot
 * carry.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  createSeededRandom,
  pickOne,
  type RandomSource,
  randomInt,
  shuffled,
} from "../../index.ts";
