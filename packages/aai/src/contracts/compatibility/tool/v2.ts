// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 2.
 *
 * Epoch 3 gave `ToolDef` an optional `messages` field — what the agent SAYS
 * while the tool runs (`start`, `delayed`) and what it says when the tool
 * lands (`complete`, `failed`, one of which can answer without the model at
 * all). It is purely additive, and this file is the evidence: `refundTool`
 * below is a complete epoch-2 tool literal with no `messages` key, and an
 * epoch-2 agent's tools all looked like this. A required field would have
 * broken every tool ever written.
 *
 * The front half is otherwise built on epoch 2's own addition, since a fixture
 * for an epoch should look like code written AT it: `ToolErrorHandler` is what
 * `onError` takes, so the classifier is declared as a named value of that type
 * and handed to the def — which is how an author shares one policy across
 * several tools, and the shape a later epoch would break by changing the
 * handler's arity or by obliging it to return a promise.
 *
 * That is the whole promise. If a later epoch makes `messages` required, or
 * moves `ToolErrorHandler`'s signature, this file reddens — the signal to DROP
 * the epoch rather than to edit the example.
 *
 * **Only `ToolErrorHandler` is rolled up at the bottom.** Epoch 2 added
 * exactly that name to epoch 1's fifteen, and `v1.ts` already names all
 * fifteen — coverage is measured per CAPABILITY, over the union of its frozen
 * examples, precisely so a second retained epoch can be about what it ADDED
 * rather than restating its predecessor.
 *
 * **Its specifiers are RELATIVE**, like every fixture here: importing the
 * package by name would resolve through its own `exports` map to whatever the
 * current build publishes, so the file would prove the CURRENT surface
 * compiles rather than that epoch 2's does.
 *
 * @module
 */

import { z } from "zod";

import type { ToolErrorHandler } from "../../../index.ts";
import { tool, toolFailure } from "../../../index.ts";

/** A credential the deploy is missing cannot be retried; a flaky upstream can. */
class MissingKeyError extends Error {}

/**
 * One classifier, declared once and shared — which is what naming the type
 * buys an author over an inline arrow.
 */
const refundPolicy: ToolErrorHandler = (err) => {
  if (err instanceof MissingKeyError) throw err;
  return toolFailure("The refunds service is unavailable right now.");
};

/** An epoch-2 tool: `onError` present, `messages` not a field yet. */
export const refundTool = tool({
  description: "Refund an order.",
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  execute: async ({ orderId, amount }, ctx) => {
    if (!ctx.env.REFUNDS_API_KEY) throw new MissingKeyError("REFUNDS_API_KEY is unset");
    return { orderId, refunded: amount };
  },
  onError: refundPolicy,
});
