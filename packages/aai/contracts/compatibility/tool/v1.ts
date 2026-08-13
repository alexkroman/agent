// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `tool` epoch 1.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import {
  type InferToolInput,
  type InferToolOutput,
  isToolFailure,
  type Message,
  type ToolContext,
  type ToolFailure,
  tool,
  toolError,
} from "../../../index.ts";

const lookupSchema = z.object({
  orderId: z.string().describe("The order to look up."),
  includeItems: z.boolean().default(false),
});

type Order = { id: string; total: number };

/** A helper that PROPAGATES a failure — the case `isToolFailure` exists for. */
function findOrder(id: string): Order | ToolFailure {
  if (id === "") return { error: "An order id is required." };
  return { id, total: 0 };
}

/** Every capability a tool body had at epoch 1. */
export const lookupOrder = tool({
  description: "Look up an order by id.",
  inputSchema: lookupSchema,
  async execute(args, ctx) {
    const order = findOrder(args.orderId);
    if (isToolFailure(order)) return order;

    // `ctx.env`, `ctx.sessionId`, `ctx.signal`, `ctx.send`.
    const region: string | undefined = ctx.env.AAI_REGION;
    ctx.send("order_opened", { id: order.id, session: ctx.sessionId, region });
    if (ctx.signal.aborted) return { error: "Cancelled." };

    // `ctx.db` — the opt-in app database.
    const rows = await ctx.db.query<{ total: number }>("select total from orders where id = $1", [
      order.id,
    ]);

    // `ctx.generate` — one-shot generation, with and without a schema.
    const plain = await ctx.generate({ prompt: "Summarize the order." });
    const structured = await ctx.generate({
      prompt: "Classify the order.",
      schema: z.object({ tier: z.enum(["standard", "priority"]) }),
    });

    // `ctx.messages` — the conversation so far.
    const lastRole: Message["role"] | undefined = ctx.messages.at(-1)?.role;

    return {
      id: order.id,
      total: rows[0]?.total ?? order.total,
      summary: plain.text,
      tier: structured.object.tier,
      lastRole,
      itemsIncluded: args.includeItems,
    };
  },
});

/** A tool with no input schema at all. */
export const ping = tool({
  description: "Check that the agent is alive.",
  execute() {
    return { ok: true };
  },
});

/** A tool whose body reports a hard failure to the model as a wire string. */
export const strict = tool({
  description: "Reject everything.",
  execute(): string {
    return toolError("Not available.");
  },
});

export type LookupInput = InferToolInput<typeof lookupOrder>;
export type LookupOutput = InferToolOutput<typeof lookupOrder>;

/** A tool authored in its own file, typed against a shared state shape. */
export function makeCounter<S extends { count: number }>() {
  return tool({
    description: "Increment the counter.",
    execute(_args: unknown, ctx: ToolContext<S>) {
      ctx.state.count += 1;
      return ctx.state.count;
    },
  });
}
