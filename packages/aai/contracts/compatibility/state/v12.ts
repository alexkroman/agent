// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 12.
 *
 * **Epoch 11 is DROPPED, and its own assertion is why.** That example pinned the
 * erasure as a compile-checked fact — `addItemOutput: InferToolOutput<typeof
 * addItem> = "still unknown at the slot boundary"`, with a doc saying "were `R`
 * threaded through the constructor, this line would be the error that says so".
 * `SessionSlot.tool` and `.updateTool` answer `ToolDef<P, R>` now, so it is that
 * error. Unlike the dialog case there was never a wrapper to justify keeping the
 * erasure: a slot tool returns the mutator's value UNCHANGED, so `unknown` was
 * only the type system dropping it at the boundary, and an epoch whose stated
 * claim is the erasure cannot be repaired without contradicting itself.
 * `contracts.json` carries the record.
 *
 * Nothing else about a slot moved. Every read is still `DeepReadonly<T>`, every
 * write still goes through a SYNCHRONOUS `update` window, `set` still stores a
 * copy, and epochs 8, 9 and 10 are all still supported and compile unchanged
 * beside this file — the change is in what the RESULT of a slot tool is known
 * to be, which is a thing only a caller of `InferToolOutput` could observe.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { type DeepReadonly, type InferToolOutput, sessionSlot, tool } from "../../../index.ts";

type Cart = { items: string[]; quote: number };

export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], quote: 0 }));

/** Unchanged from epoch 10: readonly all the way down, so it takes a read or a draft. */
export function cartSize(cart: DeepReadonly<Cart>): number {
  return cart.items.length;
}

/** A READ-ONLY tool: what it is handed is deep-frozen and deep-readonly. */
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

/**
 * What epoch 12 makes writable: both tools declare the body's own result, so a
 * custom client rendering `useToolResult<InferToolOutput<typeof addItem>>` gets
 * the real shape. At epoch 11 both of these were `unknown`, and the only way to
 * name the shape was to restate it beside the tool that already declared it.
 */
export type ItemCount = InferToolOutput<typeof addItem>;
export const sampleCount: ItemCount = { count: 1 };
export const sampleRead: InferToolOutput<typeof countItems> = { count: 0 };

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
