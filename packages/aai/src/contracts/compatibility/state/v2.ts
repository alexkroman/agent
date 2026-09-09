// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 2.
 *
 * Epoch 3 gave `SlotToolDef` an optional `onError`, the per-tool classifier
 * that turns a THROW inside a slot tool into a `ToolFailure` the model may
 * recover from. Nothing else about declaring a slot moved, and that is what
 * this file pins: `addItem` and `clearCart` below are a `tool` and an
 * `updateTool` written the way epoch 2 wrote them — a description, a schema, a
 * body taking `(args, value, ctx)` — with no `onError` key at all. A required
 * classifier would have broken every slot tool ever written; an optional one
 * breaks none.
 *
 * Epoch 2's own additions are what the front half is otherwise built on, since
 * a fixture for an epoch should look like code written AT it: the slot carries
 * its own `view`, and `cartSlot.projected` is the projection that view
 * produces — the pair that replaced calling `projection()` once per reader.
 * `projection()` itself stays for the multi-view case, and `skus` is here so
 * that too keeps compiling.
 *
 * That is the whole promise — one optional field on the tool def. If a later
 * epoch obliges a slot tool to classify its own throws, or takes `view` /
 * `projected` back out, this file reddens, which is the signal to DROP the
 * epoch rather than to edit the example.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 2's 9 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 2's does.
 *
 * @module
 */

import { z } from "zod";

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
type Cart = { items: Item[]; staffPin: string };

/**
 * The slot, declared with the epoch-2 options: a cap on the one array field, a
 * `view` naming what the browser is allowed to see, and durability.
 */
export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], staffPin: "" }), {
  durable: true,
  caps: { items: 50 },
  // `staffPin` never leaves the server, which is the whole point of a view.
  view: (cart) => ({
    count: cart.items.length,
    units: cart.items.reduce((sum, item) => sum + item.qty, 0),
  }),
});

/** Declared once on the slot, read here — epoch 2's replacement for a per-reader call. */
export const cartView = cartSlot.projected;

/** And `projection()` still serves a SECOND view of the same slot. */
export const skus = cartSlot.projection((cart) => cart.items.map((item) => item.sku));

/** A read-only slot tool: `(args, value, ctx)`, and no `onError`. */
export const addItem = cartSlot.tool({
  description: "Say how many of one SKU are already in the cart.",
  inputSchema: z.object({ sku: z.string() }),
  execute: ({ sku }, cart, ctx) => ({
    sessionId: ctx.sessionId,
    qty: cart.items.find((item) => item.sku === sku)?.qty ?? 0,
  }),
});

/** And the writing half, whose body mutates a draft rather than a frozen read. */
export const clearCart = cartSlot.updateTool({
  description: "Empty the cart.",
  execute: (_args, cart) => {
    cart.items.length = 0;
    return { emptied: true };
  },
});

/** What every slot method TAKES — a tool context, an event context, anything holding slots. */
export function unitsIn(holder: SlotHolder): number {
  return cartSlot.get(holder).items.reduce((sum, item) => sum + item.qty, 0);
}

// ── The rest of epoch 2's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch2Types = {
  deepReadonly: DeepReadonly<Cart>;
  sessionSlotHandle: SessionSlot<"cart", Cart, { count: number; units: number }>;
  sessionSlotOptions: SessionSlotOptions<Cart>;
  slotCaps: SlotCaps<Cart>;
  slotHolder: SlotHolder;
  slotStore: SlotStore;
  slotToolDef: SlotToolDef<z.ZodObject<{ sku: z.ZodString }>, DeepReadonly<Cart>, number>;
  stateProjection: StateProjection<{ count: number; units: number }>;
};

export const epoch2Values = [sessionSlot] as const;
