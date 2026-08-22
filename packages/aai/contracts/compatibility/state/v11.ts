// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 11.
 *
 * **Moved for a TRANSITIVE reason**, the same shape as epoch 9's. The export
 * list is identical to epoch 10's and `sessionSlot` and every method on it are
 * untouched. What changed is `ToolDef`, which grew a result type parameter at
 * `aai:tool` epoch 10 (see `../tool/v10.ts` for that story) — and
 * `SessionSlot.tool` / `SessionSlot.updateTool` both ANSWER a `ToolDef`, so the
 * declaration is in this capability's report and the hash moved with it. Epoch
 * 10 is RETAINED and `./v10.ts` compiles unchanged beside this file: everything
 * it demonstrates is about what a READ hands back, which this does not touch.
 *
 * What an author has to know is where the new inference STOPS. The slot
 * constructors take `R` for the body — that is what types the value `update`
 * stores — and return a bare `ToolDef<P>`, so `InferToolOutput` of a
 * slot-declared tool is still `unknown`. Reaching the same slot from an ordinary
 * `tool()` does carry it, because `SessionSlot.update` is generic in its
 * mutator's return type and `tool()` now captures whatever `execute` returns.
 *
 * That turns a spelling that used to be pure convenience into a CHOICE, and both
 * files here are the two halves of it:
 *
 * - `slot.updateTool(…)` when the result is for the model. It is shorter, it
 *   hands the body a draft, and nothing outside the agent names its shape.
 * - `tool(…)` + `slot.update(…)` when the result is also for a CLIENT. That is
 *   the only spelling whose type a custom page can reach — `useToolResult<
 *   InferToolOutput<typeof priceCart>>("price_cart", …)` — and the failure it
 *   prevents is the one that helper exists for: a page re-declaring the result
 *   shape by hand and drifting from the tool that produces it.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { type DeepReadonly, type InferToolOutput, sessionSlot, tool } from "../../../index.ts";

type Cart = { items: string[]; quote: number };

export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], quote: 0 }));

/** Unchanged from epoch 10: readonly all the way down, so it takes both forms. */
export function cartSize(cart: DeepReadonly<Cart>): number {
  return cart.items.length;
}

/**
 * The slot spelling. The body still infers `R` — `update` stores
 * `{ count: number }`, and a body returning a promise is still refused at run
 * time — but the `ToolDef` it hands back does not carry it.
 */
export const addItem = cartSlot.updateTool({
  description: "Add an item to the cart.",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }, cart) => {
    cart.items.push(item);
    return { count: cartSize(cart) };
  },
});

/**
 * The erasure, as a compile-checked fact rather than a claim: a `string` is
 * assignable here only because this really is `unknown`. Were `R` threaded
 * through the constructor, this line would be the error that says so.
 */
export const addItemOutput: InferToolOutput<typeof addItem> = "still unknown at the slot boundary";

/**
 * The `tool()` spelling, for a result a page renders. `update` returns whatever
 * the mutator returned, `tool()` captures it, and the shape has one source.
 *
 * Note the ordering rule epoch 10's predecessors already fixed and this does not
 * relax: the mutation window is SYNCHRONOUS, so anything awaited happens in
 * front of it, never inside.
 */
export const priceCart = tool({
  description: "Total the cart.",
  inputSchema: z.object({ currency: z.string() }),
  execute: ({ currency }, ctx) =>
    cartSlot.update(ctx, (cart) => {
      cart.quote = cart.items.length * 100;
      return { currency, quote: cart.quote, count: cartSize(cart) };
    }),
});

/** The type a custom client renders with, reachable now for this half. */
export type CartQuote = InferToolOutput<typeof priceCart>;

export const sampleQuote: CartQuote = { currency: "usd", quote: 0, count: 0 };

/** The projection, and the client-side fallback derived from the same function. */
export const cartView = cartSlot.projection((cart) => ({ count: cartSize(cart) }));
export const EMPTY_CART_VIEW = cartView();
