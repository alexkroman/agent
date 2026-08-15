// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 9.
 *
 * **Moved for a TRANSITIVE reason.** Nothing on this capability's own surface was
 * added, removed or renamed — the export list is identical to epoch 8's. What
 * changed is `WorkflowClient`, which gained `publicWebhookUrl`, and `ToolContext`
 * mentions it as `ctx.workflows`. A capability's hash covers the shape a consumer
 * has to satisfy, so a type reachable FROM the surface is part of it; that is the
 * same reason `includeForgottenExports` is on. Epoch 8 is RETAINED and `./v8.ts`
 * compiles unchanged beside this file.
 *
 * What is new here is the one thing that change makes writable in a tool: a
 * `ToolContext` reaches a callback URL a third party can actually POST to, where
 * before a tool could only hand out something from the workflow body — which is
 * the guest's own `localhost`. It is on `ctx` rather than an import for the reason
 * `ctx.db` and `ctx.generate` are: it is a fact about the deployment, and a tool
 * that names it works unchanged under `aai dev` and deployed.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { isToolFailure, sessionSlot, tool, toolFailure } from "../../../index.ts";

const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));

/** Unchanged from epoch 8: no annotation, and what `get` returns is readonly. */
export const viewCart = tool({
  description: "List what is in the cart.",
  inputSchema: z.object({}),
  execute: (_args, ctx) => ({ items: [...cartSlot.get(ctx).items] }),
});

/** Unchanged from epoch 8: writes go through the slot, failures the model reads. */
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
 * New at epoch 9: the token is derived from something SESSION-scoped, never from
 * anything a caller could name — the URL addresses a run, so it is a capability.
 */
export const checkoutCallbackUrl = tool({
  description: "Where the payment provider should confirm this checkout.",
  execute: (_args, ctx) => ({
    url: ctx.workflows.publicWebhookUrl(`checkout:${ctx.sessionId}`),
  }),
});
