// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 8.
 *
 * Epoch 8 is where a slot became the only thing that holds session state, and
 * where that state became DURABLE. Four things an author writes changed with it,
 * and this file is all four:
 *
 * - `update(ctx, mutate)` is SYNCHRONOUS and hands the body a mutable DRAFT.
 *   Whatever the mutator leaves behind is stored when it returns, which is what
 *   makes a read-modify-write atomic with no lock — the LLM loop runs a step's
 *   tool calls concurrently. An await goes in FRONT of the mutation, never
 *   inside it (`priceCart` below).
 * - `get` returns a frozen `Readonly<T>`. Mutating it is a compile error for the
 *   top level and a `TypeError` for anything deeper; every write goes through
 *   `update`.
 * - `projection` returns a CALLABLE carrying the slot's key and default, so the
 *   same function serves `agent({ syncState })` and a client's own empty-state
 *   fallback. `read`, `state`, `SlotState` and `SlotStateOf` went with the
 *   `ctx.state` bag.
 * - a slot may declare itself VIRTUAL (`durable: false`) for a value that could
 *   not be stored anyway.
 *
 * **"Frozen" means this file must keep compiling against current source for as
 * long as epoch 8 is advertised as supported.** A compile error here is the
 * finding, not something to edit away. Imports are RELATIVE
 * (`../../../index.ts`) because the package cannot resolve itself by name.
 */

import { z } from "zod";

import { sessionSlot, tool } from "../../../index.ts";

type Cart = { items: string[]; quote: number; log: string[] };

/**
 * The slot, with its `after` hook — invariant restoration that runs on the draft
 * at the end of every successful mutation, so the rule lives with the slot
 * rather than at every mutating call site.
 */
export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], quote: 0, log: [] }), {
  after: (cart) => {
    cart.log = cart.log.slice(-10);
  },
});

/** A READ-ONLY tool: the value it is handed is frozen. */
export const countItems = cartSlot.tool({
  description: "How many items are in the cart.",
  inputSchema: z.object({}),
  execute: (_args, cart) => ({ count: cart.items.length }),
});

/** A MUTATING tool: the body is handed a draft, and must be synchronous. */
export const addItem = cartSlot.updateTool({
  description: "Add an item to the cart.",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }, cart) => {
    cart.items.push(item);
    cart.log.push(`added ${item}`);
    return { count: cart.items.length };
  },
});

/** The await-then-mutate shape, for a body that has to call a model. */
export const priceCart = tool({
  description: "Price the cart.",
  inputSchema: z.object({}),
  execute: async (_args, ctx) => {
    const priced = await ctx.generate({ prompt: `price ${cartSlot.get(ctx).items.join(", ")}` });
    return cartSlot.update(ctx, (cart) => {
      cart.quote = Number(priced.text);
      return { quote: cart.quote };
    });
  },
});

/** The projection, and the client-side fallback derived from the same function. */
export const cartView = cartSlot.projection((cart) => ({ count: cart.items.length }));
export const EMPTY_CART_VIEW = cartView();

/** A virtual slot: never checked, never frozen, never stored. */
export const scratchSlot = sessionSlot("scratch", () => ({ seen: new Set<string>() }), {
  durable: false,
});
