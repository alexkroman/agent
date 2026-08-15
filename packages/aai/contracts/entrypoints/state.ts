// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `state`.
 *
 * Session state: the typed named slot that owns an agent's per-session value —
 * its default, its reads, its writes, its storage, and its projection to the
 * client. There is no `ctx.state` bag for it to live inside any more.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type SessionSlot,
  type SessionSlotOptions,
  type SlotStore,
  type SlotToolDef,
  type StateProjection,
  sessionSlot,
} from "../../index.ts";
