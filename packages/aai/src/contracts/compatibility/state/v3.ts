// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 3.
 *
 * Epoch 4 changed nothing about declaring a slot or writing a slot tool. What
 * moved is `ToolDef`, which gained an optional `messages` field — what the
 * agent says while a tool runs and what it says when it lands — and
 * `SlotToolDef` is that def with the slot's value threaded in, so this
 * capability's report moved with it.
 *
 * The promise is therefore narrow and exact: an epoch-3 slot tool with no
 * `messages` key still compiles, both the reading half (`slot.tool`) and the
 * writing half (`slot.updateTool`), and with the `onError` epoch 3 added.
 *
 * Coverage is per capability over the union of frozen examples, and `v1.ts`
 * and `v2.ts` already name all nine of this one's exports — so this file is
 * about the transition rather than a roll-call. Its specifiers are RELATIVE,
 * so it proves epoch 3's surface compiles rather than the current build's.
 *
 * @module
 */

import { z } from "zod";

import { sessionSlot, toolFailure } from "../../../index.ts";

type Cart = { items: { sku: string; qty: number }[] };

export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [] }), {
  durable: true,
  caps: { items: 50 },
  view: (cart) => ({ count: cart.items.length }),
});

/** The reading half at epoch 3: `(args, value, ctx)`, plus a classifier. */
export const cartCount = cartSlot.tool({
  description: "Say how many of one SKU are in the cart.",
  inputSchema: z.object({ sku: z.string() }),
  execute: ({ sku }, cart) => ({ qty: cart.items.find((i) => i.sku === sku)?.qty ?? 0 }),
  onError: () => toolFailure("I couldn't read the cart just now."),
});

/** And the writing half, mutating a draft inside a synchronous window. */
export const clearCart = cartSlot.updateTool({
  description: "Empty the cart.",
  execute: (_args, cart) => {
    cart.items.length = 0;
    return { emptied: true };
  },
});
