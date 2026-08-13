// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `state`.
 *
 * Session state: the typed named slot inside `ctx.state` that lets an agent's
 * tools live in more than one file without restating the state annotation.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type SessionSlot,
  type SessionSlotOptions,
  type SlotState,
  type SlotStateOf,
  sessionSlot,
} from "../../index.ts";
