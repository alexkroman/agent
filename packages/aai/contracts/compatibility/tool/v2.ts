// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `tool` epoch 2.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 1 is DROPPED and its example is gone. What changed for a tool author is
 * one line of it: the failure a body returns is built with `toolFailure` (or
 * the bare object) rather than with `toolError`, whose pre-serialized string
 * `isToolFailure` never narrowed. Everything else here is epoch 1 unchanged —
 * the Standard Schema spec types also left the root barrel, and no example
 * named them, which is the evidence that they were not authoring API.
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
  toolFailure,
} from "../../../index.ts";

const lookupSchema = z.object({
  orderId: z.string().describe("The order to look up."),
  includeItems: z.boolean().default(false),
});

type Order = { id: string; total: number };

/** A helper that PROPAGATES a failure — the case `isToolFailure` exists for. */
function findOrder(id: string): Order | ToolFailure {
  if (id === "") return toolFailure("An order id is required.");
  return { id, total: 0 };
}

/** Every capability a tool body has at epoch 2. */
export const lookupOrder = tool({
  description: "Look up an order by id.",
  inputSchema: lookupSchema,
  async execute(args, ctx) {
    const order = findOrder(args.orderId);
    if (isToolFailure(order)) return order;

    // `ctx.env`, `ctx.sessionId`, `ctx.signal`, `ctx.send`.
    const region: string | undefined = ctx.env.AAI_REGION;
    ctx.send("order_opened", { id: order.id, session: ctx.sessionId, region });
    if (ctx.signal.aborted) return toolFailure("Cancelled.");

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

/**
 * A body reporting a failure the MODEL should see and recover from. The object
 * literal means the same thing; the constructor is what puts the answer next to
 * the guard rather than next to the wire form.
 */
export const strict = tool({
  description: "Reject everything.",
  execute(): ToolFailure {
    return toolFailure("Not available.");
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
