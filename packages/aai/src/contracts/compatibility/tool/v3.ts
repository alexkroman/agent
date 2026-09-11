// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 3.
 *
 * Epoch 4 gave `ToolDef` two optional DECLARATIONS — `mutates` ("this call
 * changes something outside the conversation") and `completes` ("this call ends
 * or hands off the engagement") — which are what the fast/slow two-tier router
 * reads to decide whether a call is proposed by the fast tier and authorized by
 * the slow one. Both are purely additive, and this file is the evidence:
 * `refundTool` below is a complete epoch-3 tool literal declaring neither, and
 * every tool written before epoch 4 looked like this.
 *
 * Note what the promise has to cover, which is more than "it still compiles". A
 * REQUIRED `mutates` would have broken every one of those tools; a DEFAULTED one
 * would have been worse, silently classifying a refund as a read. Epoch 4's
 * field is optional and its absence means "not declared" rather than
 * "read-only", so an epoch-3 tool keeps both its shape and its meaning.
 *
 * The front half is built on epoch 3's own addition, since a fixture for an
 * epoch should look like code written AT it: `messages` is what epoch 3 added,
 * so the tool carries a conditional hold line, a two-rung delay ladder and a
 * `system` failure hint. Each kind is declared as a NAMED value rather than
 * inlined, which is how an author shares one phrasing policy across several
 * tools — and the shape a later epoch would break by changing a kind's fields,
 * or by moving `afterMs` off the rung and onto the list.
 *
 * That is the whole promise. If a later epoch makes `mutates` or `completes`
 * required, moves the role switch on a completion message, or narrows
 * `ToolMessagesInput`'s shorthands, this file reddens — the signal to DROP the
 * epoch rather than to edit the example.
 *
 * **Only epoch 3's seven names are rolled up here.** Coverage is measured per
 * CAPABILITY over the union of its frozen examples, so `v1.ts` already names
 * epoch 1's fifteen and `v2.ts` names epoch 2's `ToolErrorHandler`; this file is
 * about what epoch 3 ADDED.
 *
 * **Its specifiers are RELATIVE**, like every fixture here: importing the
 * package by name would resolve through its own `exports` map to whatever the
 * current build publishes, so the file would prove the CURRENT surface compiles
 * rather than that epoch 3's does.
 *
 * @module
 */

import { z } from "zod";

import type {
  ToolCompletionMessage,
  ToolConditionOperator,
  ToolDelayedMessage,
  ToolMessageCondition,
  ToolMessages,
  ToolMessagesInput,
  ToolStartMessage,
} from "../../../index.ts";
import { tool } from "../../../index.ts";

/**
 * Epoch 3's operator vocabulary, named rather than inlined — which is the point
 * of its being exported at all.
 */
const atLeast: ToolConditionOperator = "gte";

/** A condition read off one of the call's own arguments. */
const bigRefund: ToolMessageCondition = { arg: "amount", op: atLeast, value: 500 };

/** A hold line that fires only for the calls that will actually be slow. */
const openingLine: ToolStartMessage = {
  content: "Let me pull that refund up — this one needs a second look.",
  when: [bigRefund],
};

/**
 * A LADDER, not two variants: the offsets differ, so these speak at 3s and 8s.
 * Two entries at the same `afterMs` would be one rung with two phrasings.
 */
const ladder: readonly ToolDelayedMessage[] = [
  { afterMs: 3000, content: "Still working through it." },
  { afterMs: 8000, content: "Sorry — the refunds desk is slow today." },
];

/** `role: "system"`, so the model writes the apology instead of reading a canned one. */
const failureHint: ToolCompletionMessage = {
  role: "system",
  content: "The refund failed. Apologize and offer to email a confirmation instead.",
};

/** What an AUTHOR writes — the input shape, exercising two of its shorthands. */
const refundMessages: ToolMessagesInput = {
  start: [openingLine, "One moment."],
  delayed: ladder,
  complete: "That refund is on its way.",
  failed: [failureHint],
};

/**
 * The NORMALIZED counterpart — what a `ToolSchema` carries and the runtime
 * reads, produced from the input shape by `agentToolsToSchemas`.
 *
 * Named here because epoch 3 promised BOTH halves: freezing only the authoring
 * shape would leave the runtime's side free to move under a tool that still
 * compiled.
 */
export const refundMessagesNormalized: ToolMessages = {
  start: [openingLine],
  delayed: [...ladder],
  complete: [{ role: "assistant", content: "That refund is on its way." }],
  failed: [failureHint],
};

/** An epoch-3 tool: `messages` present, `mutates`/`completes` not fields yet. */
export const refundTool = tool({
  description: "Refund an order.",
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  messages: refundMessages,
  execute: async ({ orderId, amount }) => ({ orderId, refunded: amount }),
});
