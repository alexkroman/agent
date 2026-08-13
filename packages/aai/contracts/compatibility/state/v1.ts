// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `state` epoch 1.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { agent, type SlotStateOf, sessionSlot, tool } from "../../../index.ts";

type Cart = { items: string[]; total: number };

/**
 * The slot an agent's tools share. `create` is a FACTORY, so each session gets
 * its own object; `after` restores the invariant every mutating tool would
 * otherwise have to remember.
 */
export const cartSlot = sessionSlot<"cart", Cart>("cart", () => ({ items: [], total: 0 }), {
  after: (cart) => {
    cart.total = cart.items.length;
  },
});

export type CartState = SlotStateOf<typeof cartSlot>;

/** The client-facing projection, derived from the slot rather than restated. */
export const cartView = (cart: Cart) => ({ count: cart.items.length });

/** A synchronous read-modify-write may take the live object. */
export const clearCart = tool({
  description: "Empty the cart.",
  execute(_args, ctx: Parameters<typeof cartSlot.get>[0]) {
    const cart = cartSlot.get(ctx);
    cart.items.length = 0;
    return { cleared: true };
  },
});

/** An ASYNC mutator must serialize, which is what `update` is for. */
export const addItem = tool({
  description: "Add an item to the cart.",
  async execute(_args, ctx: Parameters<typeof cartSlot.update>[0]) {
    return await cartSlot.update(ctx, async (cart) => {
      await Promise.resolve();
      cart.items.push("widget");
      return cart.items.length;
    });
  },
});

export const resetCart = tool({
  description: "Reset the cart to its default.",
  execute(_args, ctx: Parameters<typeof cartSlot.reset>[0]) {
    const fresh = cartSlot.reset(ctx);
    cartSlot.set(ctx, { ...fresh, items: [] });
    return { ok: true };
  },
});

/** The slot composes with a declared `state` factory. */
export const statefulAgent = agent<CartState>({
  name: "Contract Fixture (state)",
  state: () => ({ [cartSlot.key]: cartSlot.create() }),
  syncState: cartSlot.projection(cartView),
  tools: { clear: clearCart, add: addItem, reset: resetCart },
});

/** `read` is the non-context half, for a projection's empty-state fallback. */
export const emptyView = cartSlot.projection(cartView)(undefined);
export const readDirect: Cart = cartSlot.read(undefined);
