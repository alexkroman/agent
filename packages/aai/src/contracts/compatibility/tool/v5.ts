// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 5.
 *
 * Epoch 6 added a field to `ToolContext` — `steerRecognizer`, which biases the
 * recognizer toward words a lookup just returned for the rest of the call — and
 * it is REQUIRED on the type rather than optional. This file is the evidence
 * that an epoch-5 tool survives that, and the reason it does is the direction
 * the type is used in: a tool BODY reads `ctx`, it never builds one. Adding a
 * member to a value somebody only receives is a widening for them, and every
 * tool written before epoch 6 looked like the one below.
 *
 * Note what the promise has to cover, which is more than "it still compiles".
 * The runtime supplies the field on every context it builds and the published
 * `createToolContext` supplies an inert one, so an epoch-5 tool and its
 * epoch-5 SPEC both keep working — a new capability that the test helper did
 * not also learn would break every spec in a user's project while their agent
 * kept running, which is the worse half of this failure and the one worth
 * pinning.
 *
 * The tool is built on epoch 5's own shape, since a fixture for an epoch should
 * look like code written AT it: a zod `parameters`, a `ToolFailure` return for
 * the recoverable miss, spoken `messages` for the wait, and a body that reads
 * several `ctx` members — `env`, `slots`, `sessionId`, `generate` — because
 * what is being promised is precisely that reading a context is unaffected by
 * the context gaining members.
 *
 * That is the whole promise, and here is its BOUNDARY: it does not cover code
 * that CONSTRUCTS a `ToolContext` by hand. Such code has to supply the new
 * field, which is why the published helper exists and why a hand-rolled stub
 * was always the shape this repo warned against. If a later epoch makes an
 * existing `ToolDef` field required, changes what `execute` may return, or
 * narrows `inputSchema`, this file reddens — the signal to DROP the epoch
 * rather than to edit the example.
 */

import { z } from "zod";

import { tool } from "../../../index.ts";
import { sessionSlot } from "../../../sdk/session-slot.ts";
import { isToolFailure, toolFailure } from "../../../sdk/utils.ts";

const cart = sessionSlot("cart", () => ({ items: [] as string[] }));

export const lookupOrderTool = tool({
  description: "Look up one of the caller's orders by its id.",
  inputSchema: z.object({
    orderId: z.string().min(1).describe("The order id, digits only."),
  }),
  messages: {
    start: [{ content: "Let me pull that order up." }],
    delayed: [{ afterMs: 4000, content: "Still looking — one moment." }],
    failed: [{ role: "system", content: "Say plainly that the order was not found." }],
  },
  async execute({ orderId }, ctx) {
    // Reading the context is the point of the fixture: each of these is a
    // member an epoch-5 tool already used, and none of them moved.
    const region = ctx.env.ORDER_REGION ?? "us";
    const held = cart.get(ctx).items.length;
    const response = await fetch(`https://orders.example.com/${region}/${orderId}`, {
      signal: ctx.signal,
    });
    if (!response.ok) return toolFailure(`No order ${orderId} on this account.`);
    const order = (await response.json()) as { status: string; items: string[] };
    // `generate` too, since a context member that is a FUNCTION is the one most
    // exposed to a signature change one epoch later.
    const summary = await ctx.generate({
      prompt: `One sentence, for a phone call: order ${orderId} is ${order.status}.`,
    });
    return { sessionId: ctx.sessionId, held, summary: summary.text, status: order.status };
  },
});

/** The failure arm, unwrapped the way an epoch-5 caller unwrapped it. */
export function describeResult(
  result: { summary: string } | ReturnType<typeof toolFailure>,
): string {
  return isToolFailure(result) ? result.error : result.summary;
}
