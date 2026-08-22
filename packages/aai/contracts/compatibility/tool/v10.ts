// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 10.
 *
 * **`ToolDef` grew a second type parameter, and `tool()` now declares its
 * argument as `ToolDef<P, R>` rather than re-stating the shape inline.** The
 * export list is identical to epoch 9's; what moved is the SIGNATURE, which is
 * why this is a retain rather than an addition.
 *
 * Before this epoch `execute` was typed `Promise<unknown> | unknown`, so the
 * body's real return type was erased at the `tool()` call and
 * {@link InferToolOutput} resolved to `unknown` for EVERY tool — a published
 * inference helper whose doc promised a single source of truth and delivered
 * none. `R` captures it, and defaults to `unknown` so the one-argument spelling
 * `ToolDef<typeof schema>` keeps its old meaning: epoch 9 is RETAINED and
 * `./v9.ts` compiles unchanged beside this file, which is the whole evidence
 * that adding the parameter broke nobody.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import {
  type InferToolInput,
  type InferToolOutput,
  isToolFailure,
  sessionSlot,
  type ToolDef,
  type ToolInputSchema,
  tool,
  toolFailure,
} from "../../../index.ts";

const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));

/** Unchanged from epoch 9: no annotation, and what `get` returns is readonly. */
export const viewCart = tool({
  description: "List what is in the cart.",
  inputSchema: z.object({}),
  execute: (_args, ctx) => ({ items: [...cartSlot.get(ctx).items] }),
});

/** Unchanged from epoch 9: writes go through the slot, failures the model reads. */
export const removeItem = tool({
  description: "Remove an item from the cart.",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }, ctx) =>
    cartSlot.update(ctx, (cart) => {
      const at = cart.items.indexOf(item);
      if (at < 0) return toolFailure(`${item} is not in the cart.`);
      cart.items.splice(at, 1);
      return { removed: item, count: cart.items.length };
    }),
});

/** The guard still narrows a forwarded failure, unchanged by this epoch. */
export function removedOrReason(result: Awaited<ReturnType<typeof removeItem.execute>>): string {
  return isToolFailure(result) ? result.error : "removed";
}

/**
 * New at epoch 10: the result type is REACHABLE, for a sync body and an `async`
 * one alike. A custom client renders `useToolResult<InferToolOutput<typeof
 * priceCart>>("price_cart", …)` and gets the real shape rather than `unknown`.
 */
export const priceCart = tool({
  description: "Total the cart.",
  inputSchema: z.object({ currency: z.string() }),
  execute: async ({ currency }, ctx) => ({
    currency,
    total: cartSlot.get(ctx).items.length * 100,
  }),
});

export type CartPrice = InferToolOutput<typeof priceCart>;
export type CartPriceArgs = InferToolInput<typeof priceCart>;

/** The awaited result really is the object literal, not `unknown`. */
export const samplePrice: CartPrice = { currency: "usd", total: 0 };
export const samplePriceArgs: CartPriceArgs = { currency: "usd" };

/**
 * The one-argument spelling still means "any result", which is what makes the
 * new parameter source-compatible: a table annotated before epoch 10 accepts a
 * tool whose body returns something concrete.
 */
export const table: Readonly<Record<string, ToolDef<ToolInputSchema>>> = {
  price_cart: priceCart,
  remove_item: removeItem,
  view_cart: viewCart,
};
