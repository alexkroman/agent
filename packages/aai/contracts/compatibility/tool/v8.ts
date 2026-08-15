// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 8.
 *
 * Epoch 8 removed the state type parameter from `ToolContext` and `ToolDef`. It
 * existed so `ctx.state` could be typed, and a tool could only learn the shape
 * from an ANNOTATED context — which a tool in its own file cannot supply, so
 * every module in a multi-file agent either restated the annotation or cast.
 *
 * A `sessionSlot` is that job now, and this file is what a tool looks like
 * without the annotation: `ctx` is inferred, the state is typed by the slot, and
 * the file names no state type at all.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { isToolFailure, sessionSlot, tool, toolFailure } from "../../../index.ts";

const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));

/** Reading: no annotation, and what `get` returns is readonly. */
export const viewCart = tool({
  description: "List what is in the cart.",
  inputSchema: z.object({}),
  execute: (_args, ctx) => ({ items: [...cartSlot.get(ctx).items] }),
});

/** Writing: through the slot, and the failure a model can recover from. */
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
