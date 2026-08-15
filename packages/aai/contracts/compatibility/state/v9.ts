// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 9.
 *
 * **Moved for a TRANSITIVE reason.** `sessionSlot` and every method on it are
 * untouched, and the export list is identical to epoch 8's. What changed is
 * `WorkflowClient`, which gained `publicWebhookUrl`, and this capability's
 * signatures mention `ToolContext` — which reaches the client as `ctx.workflows`.
 * A capability's hash covers the shape a consumer has to satisfy, so a type
 * reachable FROM the surface is part of it. Epoch 8 is RETAINED and `./v8.ts`
 * compiles unchanged beside this file.
 *
 * The example is therefore epoch 8's rules, written against the one thing that
 * change makes writable: a mutating window that records a URL the deployment
 * knows. It respects the rule that decides whether that compiles at all —
 * `publicWebhookUrl` is SYNCHRONOUS, so it belongs inside the window, where an
 * `await` would not.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { sessionSlot } from "../../../index.ts";

type Checkout = { callbackUrl: string | null; log: string[] };

export const checkoutSlot = sessionSlot(
  "checkout",
  (): Checkout => ({ callbackUrl: null, log: [] }),
  {
    // Invariant restoration on the draft at the end of every mutation, so the
    // rule lives with the slot rather than at every mutating call site.
    after: (checkout) => {
      checkout.log = checkout.log.slice(-10);
    },
  },
);

/** A READ-ONLY tool: the value it is handed is frozen. */
export const callbackStatus = checkoutSlot.tool({
  description: "Whether this checkout has a callback URL yet.",
  inputSchema: z.object({}),
  execute: (_args, checkout) => ({ ready: checkout.callbackUrl !== null }),
});

/**
 * A MUTATING tool: the body is handed a draft and must be SYNCHRONOUS — which is
 * exactly why a synchronous `publicWebhookUrl` can be called from inside one, and
 * why anything awaited has to happen in an ordinary `tool()` first.
 */
export const beginCheckout = checkoutSlot.updateTool({
  description: "Mint this session's payment callback URL.",
  inputSchema: z.object({}),
  execute: (_args, checkout, ctx) => {
    checkout.callbackUrl = ctx.workflows.publicWebhookUrl(`checkout:${ctx.sessionId}`);
    checkout.log.push("callback minted");
    return { url: checkout.callbackUrl };
  },
});

/** The projection, and the client-side fallback derived from the same function. */
export const checkoutView = checkoutSlot.projection((checkout) => ({
  ready: checkout.callbackUrl !== null,
}));
export const EMPTY_CHECKOUT_VIEW = checkoutView();
