// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 1.
 *
 * Epoch 2 let a slot carry its own `view` and exposed `slot.projected`, so a
 * view is declared once instead of at both ends. Epoch 1 declared the slot
 * without a view and called `slot.projection(view)` per reader, which is what
 * this file pins — `projection()` stays for the multi-view case, and the two
 * type parameters an epoch-1 author wrote still infer with a third added and
 * defaulted.
 */

import { sessionSlot } from "@alexkroman1/aai";

type Item = { sku: string; qty: number };
type Cart = Item[];

// No `view` option: epoch 1 had none, and the whole value is the frame.
export const cartSlot = sessionSlot("cart", (): Cart => []);

// A projection built per reader — two of these are two objects, which is
// exactly the drift epoch 2's `projected` removes. It still has to compile.
export const summary = cartSlot.projection((cart) => ({
  count: cart.length,
  units: cart.reduce((sum, item) => sum + item.qty, 0),
}));

export const skus = cartSlot.projection((cart) => cart.map((item) => item.sku));
