// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 11.
 *
 * **Moved for a TRANSITIVE reason, and nothing a tool author writes changed.**
 * The export list is identical to epoch 10's and every signature this capability
 * owns is unchanged. What moved is `WorkflowClient`, which gained `lastLine` at
 * `aai:workflow` epoch 10 (see `../workflow/v10.ts`); `ToolContext.workflows` is
 * one, so the declaration lands in this capability's report and the hash moved
 * with it. Epoch 10 is RETAINED and `./v10.ts` compiles unchanged beside this
 * file.
 *
 * That transitivity is the mechanism working rather than a nuisance: a mention
 * is part of a capability's shape, so a tool body's view of `ctx` really did
 * widen, and the one example worth adding here is the call that proves a tool
 * can make it.
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

/** Unchanged from epoch 10: no annotation, and what `get` returns is readonly. */
export const viewCart = tool({
  description: "List what is in the cart.",
  inputSchema: z.object({}),
  execute: (_args, ctx) => ({ items: [...cartSlot.get(ctx).items] }),
});

/** Unchanged from epoch 10: writes go through the slot, failures the model reads. */
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

/** Unchanged from epoch 10: the result type is REACHABLE for an async body too. */
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

export const samplePrice: CartPrice = { currency: "usd", total: 0 };
export const samplePriceArgs: CartPriceArgs = { currency: "usd" };

/**
 * What epoch 11 makes reachable from a tool body: the newest progress chunk of a
 * run this session started, without the `streamTail`-then-`stream` composition
 * that hangs on a channel nothing has written to yet.
 */
export const checkout = tool({
  description: "Report on the checkout run.",
  inputSchema: z.object({ runId: z.string() }),
  execute: async ({ runId }, ctx) => {
    const line = await ctx.workflows.lastLine(runId);
    return { status: line === undefined ? "queued" : String(line) };
  },
});

/**
 * Unchanged from epoch 10, and still the compatibility claim that matters: the
 * one-argument spelling means "any result", so a table annotated before the
 * second type parameter existed accepts every tool above.
 */
export const table: Readonly<Record<string, ToolDef<ToolInputSchema>>> = {
  checkout,
  price_cart: priceCart,
  remove_item: removeItem,
  view_cart: viewCart,
};
