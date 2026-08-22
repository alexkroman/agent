// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `text`.
 *
 * Running an agent as text rather than speech — the mode with no session,
 * used by the studio's own coding agent.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  createTextAgent,
  type TextAgent,
  type TextAgentOptions,
  type TextTurnOptions,
  type TextTurnResult,
} from "../../runtime-barrel.ts";
