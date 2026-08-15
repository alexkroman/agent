// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 12.
 *
 * Epoch 12 dropped `createToolContext`'s state type parameter and its `state`
 * bag. What a context carries instead is `slots` — a REAL slot store, not a
 * stub: it applies the same storability check and the same freeze the deployed
 * one does, which is what makes a template holding a `Map` in a slot fail in its
 * own spec rather than on the first deployment that has a database.
 *
 * So a spec sets state up through the slot, exactly as a tool does, and each
 * call is still a distinct session.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { sessionSlot } from "../../../index.ts";
import { createToolContext } from "../../../sdk/testing.ts";

const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));

const addItem = cartSlot.updateTool({
  description: "Add an item.",
  execute: (_args, cart) => {
    cart.items.push("apple");
    return { count: cart.items.length };
  },
});

/** Arrange through the slot, act through the tool, assert through the slot. */
export function addsToASeededCart(): number {
  const ctx = createToolContext({ sessionId: "spec-1" });
  cartSlot.update(ctx, (cart) => cart.items.push("pear"));
  void addItem.execute({}, ctx);
  return cartSlot.get(ctx).items.length;
}

/** Two contexts are two sessions, so their slots are independent. */
export function isolatedBySession(): boolean {
  const a = createToolContext();
  const b = createToolContext();
  cartSlot.update(a, (cart) => cart.items.push("apple"));
  return cartSlot.get(b).items.length === 0;
}
