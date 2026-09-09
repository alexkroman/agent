// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 1.
 *
 * Epoch 2 made two additive widenings, and this file is the evidence that both
 * really are additive.
 *
 * **`ToolDef` gained an optional `onError`** — the per-tool classifier that
 * turns a THROW into a `ToolFailure` the model may recover from. An epoch-1
 * tool had no such field and did the whole job inside the body: a named lookup
 * answering `T | ToolFailure`, a guard, and the failure returned on the way
 * out. That is what `cancelOrderTool` below is written as, and a `ToolDef`
 * literal carrying no `onError` key at all is still a complete tool.
 *
 * **`Message` gained optional `toolName` and `toolCallId`**, so a tool reading
 * `ctx.messages` now sees two keys it did not before. Both directions are
 * pinned deliberately: `recentAsk` READS a message by `role` and `content`
 * only, and `restatement` CONSTRUCTS a `Message` literal with neither new key
 * — the assignability a required field would have broken.
 *
 * That is the whole promise: two optional additions. If a later epoch makes
 * either `Message` field required, or obliges a tool to classify its own
 * throws, this file reddens — which is the signal to DROP the epoch rather
 * than to edit the example.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's 15 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 1's does.
 *
 * @module
 */

import { z } from "zod";

import type {
  DefaultToolResult,
  InferSchemaOutput,
  InferToolInput,
  InferToolOutput,
  Message,
  ToolContext,
  ToolDef,
  ToolFailure,
  ToolInputSchema,
} from "../../../index.ts";
import { failable, isToolFailure, orFail, requireEnv, tool, toolFailure } from "../../../index.ts";

type Order = { id: string; total: number; shipped: boolean };

const orders: Readonly<Record<string, Order>> = {
  A1: { id: "A1", total: 42, shipped: false },
  A2: { id: "A2", total: 7, shipped: true },
};

// A named lookup that answers `T | ToolFailure` rather than throwing — the
// shape `orFail` forwards out of the chain below.
function findOrder(id: string): Order | ToolFailure {
  return orders[id] ?? toolFailure(`I couldn't find an order called ${id}.`);
}

function assertUnshipped(order: Order): ToolFailure | null {
  return order.shipped ? toolFailure(`Order ${order.id} has already shipped.`) : null;
}

// Two guards in front of the work, forwarded once instead of re-tested at each
// step. `failable` absorbs `orFail`'s sentinel, so the return is
// `{ … } | ToolFailure`.
const cancelOrder = failable((id: string) => {
  const order = orFail(findOrder(id));
  orFail(assertUnshipped(order));
  return { cancelled: order.id, refunded: order.total };
});

const cancelSchema = z.object({ id: z.string().describe("The order id.") });

/**
 * An epoch-1 tool: no `onError`, and every recoverable outcome RETURNED as a
 * `ToolFailure` by the body itself.
 */
export const cancelOrderTool = tool({
  description: "Cancel an order that has not shipped yet.",
  inputSchema: cancelSchema,
  execute: (args, ctx) => {
    const receipts = requireEnv(ctx, "RECEIPTS_URL");
    const outcome = cancelOrder(args.id);
    if (isToolFailure(outcome)) return outcome;
    return { ...outcome, receipt: `${receipts}/${outcome.cancelled}` };
  },
});

/** Reading the history the epoch-1 way: `role` and `content`, and no more. */
export function recentAsk(ctx: ToolContext): string | undefined {
  return ctx.messages.findLast((message) => message.role === "user")?.content;
}

/** And CONSTRUCTING one, with neither of epoch 2's two optional keys. */
export function restatement(text: string): Message {
  return { role: "assistant", content: `You said: ${text}` };
}

// ── The rest of epoch 1's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch1Types = {
  defaultToolResult: DefaultToolResult;
  inferSchemaOutput: InferSchemaOutput<typeof cancelSchema>;
  inferToolInput: InferToolInput<typeof cancelOrderTool>;
  inferToolOutput: InferToolOutput<typeof cancelOrderTool>;
  message: Message;
  toolContext: ToolContext;
  toolDef: ToolDef;
  toolFailure: ToolFailure;
  toolInputSchema: ToolInputSchema;
};

export const epoch1Values = [
  failable,
  isToolFailure,
  orFail,
  requireEnv,
  tool,
  toolFailure,
] as const;
