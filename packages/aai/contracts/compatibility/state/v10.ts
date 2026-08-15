// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 10.
 *
 * Epoch 10 is where the READING half's type caught up with the runtime.
 * `freezeStorable` has always deep-frozen a durable value, and `get` described
 * only the top level with `Readonly<T>` — so `cart.items.push(x)` compiled and
 * threw on the first call, which two shipped templates did. `get`, `set`,
 * `reset`, `tool` and `projection` all hand out `DeepReadonly<T>` now, and the
 * type is exported so an agent's own modules can name it.
 *
 * Two things an author writes because of that, and this file is both:
 *
 * - **A domain helper over a slot read declares `DeepReadonly<T>`.** That is
 *   the whole cost of the change: `readonly string[]` is not assignable to
 *   `string[]`, so a helper typed over the mutable shape no longer accepts a
 *   read. A helper that will not take the readonly form is one that mutates,
 *   which is the finding rather than the inconvenience — and it stays perfectly
 *   callable from inside `update`, where the draft IS mutable.
 * - **`set` is safe to call with an object the caller keeps.** It stores a
 *   copy, so the freeze lands on the slot's object; before epoch 10 it froze
 *   the caller's own, and a load/import/restore is precisely a caller still
 *   holding what it passed.
 *
 * Epoch 9 is RETAINED and `./v9.ts` compiles unchanged beside this file:
 * nothing epoch 9 demonstrated mutates a read.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { type DeepReadonly, sessionSlot, tool } from "../../../index.ts";

type Cart = { items: string[]; quote: number };

export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], quote: 0 }));

/**
 * The shape a domain helper takes at epoch 10: readonly all the way down, so it
 * accepts a `get` read AND the mutable draft inside `update`.
 */
export function cartSize(cart: DeepReadonly<Cart>): number {
  return cart.items.length;
}

/** A READ-ONLY tool: what it is handed is deep-frozen, and now deep-readonly. */
export const countItems = cartSlot.tool({
  description: "How many items are in the cart.",
  inputSchema: z.object({}),
  execute: (_args, cart) => ({ count: cartSize(cart) }),
});

/** A MUTATING tool: the draft is still `Cart`, so it still mutates freely. */
export const addItem = cartSlot.updateTool({
  description: "Add an item to the cart.",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }, cart) => {
    cart.items.push(item);
    return { count: cartSize(cart) };
  },
});

/** `set` takes a value the caller may go on using — it stores a copy. */
export const restoreCart = tool({
  description: "Restore a saved cart.",
  inputSchema: z.object({ items: z.array(z.string()) }),
  execute: ({ items }, ctx) => {
    const loaded: Cart = { items: [...items], quote: 0 };
    const stored = cartSlot.set(ctx, loaded);
    // The caller's object is untouched by the freeze; the slot's is frozen.
    loaded.items.push("scratch");
    return { count: cartSize(stored) };
  },
});

/** The projection, and the client-side fallback derived from the same function. */
export const cartView = cartSlot.projection((cart) => ({ count: cartSize(cart) }));
export const EMPTY_CART_VIEW = cartView();
