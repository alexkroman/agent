// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 12.
 *
 * **What moved: `ToolContext` gained `delegate`.** A tool body can hand a
 * bounded task to a SUBAGENT — a second tool loop with its own instructions,
 * model, tools and context window — and receive what it concluded rather than
 * how it got there. The declaration itself belongs to `aai:subagent`; what
 * lands here is that `ctx` carries it, which is a change to the tool contract
 * whatever the field's own contract says.
 *
 * Epoch 11 is RETAINED and `./v11.ts` compiles unchanged beside this file:
 * a field ADDED to a context the framework supplies breaks nothing an author
 * wrote. Everything above `research` below is epoch 11's, spelling for
 * spelling; `research` is the one call epoch 11 could not make.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */
import { z } from "zod";

import {
  type DelegateResult,
  type InferToolInput,
  type InferToolOutput,
  isToolFailure,
  sessionSlot,
  subagent,
  type ToolDef,
  type ToolInputSchema,
  tool,
  toolFailure,
} from "../../../index.ts";

/** Declared at module scope, so one descriptor is reused across a session. */
const shopper = subagent({
  name: "shopper",
  instructions: "Price the items you are given. Finish with a one-line total.",
  maxSteps: 4,
});

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
 * What epoch 12 makes reachable from a tool body: a second tool loop, whose
 * intermediate work never enters this conversation. `await`ed like anything
 * else, so several runs fan out with `Promise.all`.
 */
export const research = tool({
  description: "Price the cart against the open market.",
  inputSchema: z.object({ items: z.array(z.string()) }),
  execute: async ({ items }, ctx) => {
    const runs: DelegateResult[] = await Promise.all(
      items.map((item) => ctx.delegate(shopper, { task: item, context: "Prices in USD." })),
    );
    return {
      quotes: runs.map((run) => run.text),
      lookups: runs.reduce((total, run) => total + run.toolCalls.length, 0),
    };
  },
});

/**
 * Unchanged from epoch 10, and still the compatibility claim that matters: the
 * one-argument spelling means "any result", so a table annotated before the
 * second type parameter existed accepts every tool above.
 */
export const table: Readonly<Record<string, ToolDef<ToolInputSchema>>> = {
  checkout,
  research,
  price_cart: priceCart,
  remove_item: removeItem,
  view_cart: viewCart,
};
