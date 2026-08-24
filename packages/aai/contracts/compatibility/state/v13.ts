// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 13.
 *
 * **Moved for a TRANSITIVE reason, and nothing a slot writes changed.**
 * `ToolContext` gained `delegate` (`aai:subagent`); `SlotToolDef` and the
 * `set`/`get`/`update` signatures all name a `ToolContext`, so the declaration
 * lands in this capability's report and the hash moved with it. Epoch 12 is
 * RETAINED and `./v12.ts` compiles unchanged beside this file.
 *
 * The rule a slot cares about is unaffected and worth restating, because it is
 * the one a delegating tool can get wrong: `update`'s window is SYNCHRONOUS, so
 * a body that delegates does it OUTSIDE the window and mutates once the run has
 * come back.
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
