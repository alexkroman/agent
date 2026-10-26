// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `state`.
 *
 * Session state: the typed named slot that owns an agent's per-session value —
 * its default, its reads, its writes, its storage, and its projection to the
 * client. There is no `ctx.state` bag for it to live inside any more.
 *
 * `SlotHolder` is what every one of those methods TAKES: a tool context, or a
 * session event context, or anything else carrying the session's slots.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type DeepReadonly,
  // The slot tool forms (`updateTool` with `prepare`, the dialog gate on a slot
  // tool, `slot.transact`) and the two value types read off a handle.
  type GatedOutput,
  type SessionSlot,
  type SessionSlotOptions,
  type SlotCaps,
  type SlotDialogGate,
  type SlotDraftOf,
  type SlotHolder,
  type SlotPreparedToolDef,
  type SlotStore,
  type SlotToolDef,
  type SlotTransaction,
  type SlotUpdateToolDef,
  type SlotValueOf,
  type StateProjection,
  sessionSlot,
  // What the UNGATED `tool`/`updateTool` overloads say about `dialog`: the
  // message a gated def that fits no overload is reported with.
  type UngatedDef,
} from "../../index.ts";
