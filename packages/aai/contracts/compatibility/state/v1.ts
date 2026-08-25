// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 example: `aai:state`. A slot as it was authored before
 * {@link SlotHolder} existed — every accessor called with a full
 * {@link ToolContext}, which is the only thing that could reach one then.
 *
 * FROZEN, and a PROMISE rather than a decoration: epoch 1 is retained as
 * supported, so `pnpm typecheck` compiling this file is the evidence that a slot
 * written at that epoch still compiles. An error here IS the finding — do not
 * edit it to follow a change in the API. That is what a new epoch is for.
 *
 * What epoch 2 changed, and why this file is the proof it changed SAFELY: those
 * accessors take a `SlotHolder` now (`{ slots, sessionId }`) so a session event
 * handler can maintain a slot as well as a tool body. A `ToolContext` satisfies
 * it structurally, so every line below is untouched — which is exactly the claim
 * a retained epoch makes.
 *
 * The imports are relative source paths because nothing ships this file — and
 * because the claim is about the TREE: a package-name import would resolve to
 * the built surface and prove something about `dist/` instead.
 */

import { z } from "zod";
import type { DeepReadonly, ToolContext } from "../../../index.ts";
import { sessionSlot, tool } from "../../../index.ts";

type Cart = { items: string[]; total: number };

/** The slot, with the invariant hook that runs inside the mutation window. */
const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], total: 0 }), {
  after: (cart) => {
    cart.total = cart.items.length;
  },
});

/** A read, typed by the slot rather than by an annotated context. */
function summarize(cart: DeepReadonly<Cart>): string {
  return `${cart.total} item(s)`;
}

/** Every accessor, each handed the full tool context epoch 1 required. */
export function exerciseSlot(ctx: ToolContext): string {
  const fresh = cartSlot.get(ctx);
  cartSlot.set(ctx, { items: ["mug"], total: 1 });
  cartSlot.update(ctx, (cart) => {
    cart.items.push("kettle");
  });
  const restored = cartSlot.reset(ctx);
  return `${summarize(fresh)} ${summarize(restored)} ${cartSlot.key} ${cartSlot.durable}`;
}

/** The two tool halves — the reading one, and the draft one. */
export const viewCart = cartSlot.tool({
  description: "Read the cart.",
  execute: (_args, cart) => ({ summary: summarize(cart) }),
});

export const addItem = cartSlot.updateTool({
  description: "Add an item to the cart.",
  inputSchema: z.object({ item: z.string() }),
  execute: (args, cart) => {
    cart.items.push(args.item);
    return { items: cart.items.length };
  },
});

/** A plain tool reaching the slot itself, which is why `get` takes a context. */
export const cartSize = tool({
  description: "How big is the cart?",
  inputSchema: z.object({}),
  execute: (_args, ctx) => ({ size: cartSlot.get(ctx).items.length }),
});

/** The projection both ends read. */
export const cartProjection = cartSlot.projection((cart) => ({ total: cart.total }));
