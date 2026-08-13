// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `state` epoch 2.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * What epoch 2 adds over epoch 1 — which still compiles beside this file, and
 * is the same agent written the long way — is that a slot now declares its own
 * `AgentDef.state` factory and its own tools. Between them, `slot.state`,
 * `slot.tool` and `slot.updateTool` mean the state shape is spelled once: no
 * `() => ({ [slot.key]: slot.create() })`, no `ToolContext<SlotStateOf<…>>`
 * annotation on a tool in its own module, and no opening `slot.get(ctx)`.
 */

import { agent, type SlotStateOf, sessionSlot } from "../../../index.ts";

type Cart = { items: string[]; total: number };

export const cartSlot = sessionSlot<"cart", Cart>("cart", () => ({ items: [], total: 0 }), {
  after: (cart) => {
    cart.total = cart.items.length;
  },
});

export type CartState = SlotStateOf<typeof cartSlot>;

export const cartView = (cart: Cart) => ({ count: cart.items.length });

/**
 * A synchronous read-modify-write. `execute` is handed the live value SECOND,
 * so the body names neither the context nor its type.
 */
export const clearCart = cartSlot.tool({
  description: "Empty the cart.",
  execute(_args, cart) {
    cart.items.length = 0;
    return { cleared: true };
  },
});

/**
 * An ASYNC mutator takes `updateTool`, which runs the body inside the slot's
 * per-session lock and then its `after` hook.
 */
export const addItem = cartSlot.updateTool({
  description: "Add an item to the cart.",
  async execute(_args, cart) {
    await Promise.resolve();
    cart.items.push("widget");
    return cart.items.length;
  },
});

/** `ctx` is still there, third, for the tools that need it. */
export const announce = cartSlot.tool({
  description: "Tell the client what is in the cart.",
  execute(_args, cart, ctx) {
    ctx.send("cart", cartView(cart));
    return { sent: true };
  },
});

/** `set`/`reset` are unchanged, and reachable from a slot tool's context. */
export const resetCart = cartSlot.tool({
  description: "Reset the cart to its default.",
  execute(_args, _cart, ctx) {
    const fresh = cartSlot.reset(ctx);
    cartSlot.set(ctx, { ...fresh, items: [] });
    return { ok: true };
  },
});

/** `slot.state` IS the `AgentDef.state` factory. */
export const statefulAgent = agent<CartState>({
  name: "Contract Fixture (state)",
  state: cartSlot.state,
  syncState: cartSlot.projection(cartView),
  tools: { clear: clearCart, add: addItem, announce, reset: resetCart },
});

export const emptyView = cartSlot.projection(cartView)(undefined);
export const readDirect: Cart = cartSlot.read(undefined);
