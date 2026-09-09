// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 1.
 *
 * Epoch 2 let a slot carry its own `view` and exposed `slot.projected`, so a
 * view is declared once instead of at both ends. Epoch 1 declared the slot
 * without a view and called `slot.projection(view)` per reader, which is what
 * this pins — `projection()` stays for the multi-view case, and the two type
 * parameters an epoch-1 author wrote still infer with a third added and
 * defaulted.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's 9 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 1's does.
 *
 * @module
 */

import type {
  DeepReadonly,
  SessionSlot,
  SessionSlotOptions,
  SlotCaps,
  SlotHolder,
  SlotStore,
  SlotToolDef,
  StateProjection,
} from "../../../index.ts";
import { sessionSlot } from "../../../index.ts";

type Item = { sku: string; qty: number };
type Cart = Item[];

// No `view` option: epoch 1 had none, and the whole value is the frame.
export const cartSlot = sessionSlot("cart", (): Cart => []);

// A projection built per reader. Two of these are two objects, which is the
// drift epoch 2's `projected` removes — and it still has to compile.
export const summary = cartSlot.projection((cart) => ({
  count: cart.length,
  units: cart.reduce((sum, item) => sum + item.qty, 0),
}));

export const skus = cartSlot.projection((cart) => cart.map((item) => item.sku));

// ── The rest of epoch 1's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch1Types = {
  deepReadonly: DeepReadonly<{ a: string }>;
  sessionSlotHandle: SessionSlot<string, { a: string }>;
  sessionSlotOptions: SessionSlotOptions<{ a: string }>;
  slotCaps: SlotCaps<{ items: readonly string[] }>;
  slotHolder: SlotHolder;
  slotStore: SlotStore;
  slotToolDef: SlotToolDef<never, { a: string }, string>;
  stateProjection: StateProjection;
};
