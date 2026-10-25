// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 1.
 *
 * A tool file as it was written against epoch 1: `tool()` over a zod schema,
 * the spoken messages, an `onError` classifier, the `failable`/`orFail` pair
 * around a vendor call, a `clientTool`, and the type helpers a spec reads the
 * tool's shape through. It must keep compiling against current source for as
 * long as epoch 1 is advertised as supported.
 *
 * What epoch 2 moved, and why this file still compiles:
 *
 * - `ToolDef`'s schema parameter now defaults to `ToolInputSchema | undefined`,
 *   so a tool without an `inputSchema` is typed as taking no arguments. A def
 *   written WITH a schema infers exactly as before, and one written without
 *   still declares `execute` the way `endCall` and `handWritten` do below.
 * - `InferSchemaOutput<undefined>` is `Record<string, never>` rather than
 *   `never`; for a schema it is the schema's output, as before.
 * - `ToolMap` holds the widened `ToolDef`, which every `tool()` result still
 *   satisfies.
 */

import { z } from "zod";
import {
  type ClientToolDef,
  clientTool,
  type DefaultToolResult,
  failable,
  type InferSchemaOutput,
  type InferToolInput,
  type InferToolOutput,
  isToolFailure,
  type Message,
  orFail,
  requireEnv,
  type ToolCompletionMessage,
  type ToolConditionOperator,
  type ToolContext,
  type ToolDef,
  type ToolDelayedMessage,
  type ToolErrorHandler,
  type ToolFailure,
  type ToolInputSchema,
  type ToolMap,
  type ToolMessageCondition,
  type ToolMessages,
  type ToolMessagesInput,
  type ToolRefusal,
  type ToolRefusalReason,
  type ToolStartMessage,
  tool,
  toolFailure,
  toolRefusal,
} from "../../../index.ts";

// --- Input ------------------------------------------------------------------

const LookupInput = z.object({ orderId: z.string(), items: z.number().int().optional() });
type LookupInput = InferSchemaOutput<typeof LookupInput>;
export const schema: ToolInputSchema = LookupInput;

// --- What the agent says while the tool runs -------------------------------

const op: ToolConditionOperator = "gt";
const whenMany: ToolMessageCondition = { arg: "items", op, value: 1 };
const start: ToolStartMessage = { content: "Looking that up.", blocking: false };
const delayed: ToolDelayedMessage = { content: "Still looking.", afterMs: 2000 };
const complete: ToolCompletionMessage = {
  content: "Found them.",
  when: [whenMany],
  role: "assistant",
};
const messages: ToolMessagesInput = {
  start: [start],
  delayed: [delayed],
  complete: [complete],
  failed: "Nothing came back.",
};

/** What the runtime normalizes `messages` into — read, never built. */
export function messageCount(normalized: ToolMessages): number {
  return (
    (normalized.start?.length ?? 0) +
    (normalized.delayed?.length ?? 0) +
    (normalized.complete?.length ?? 0) +
    (normalized.failed?.length ?? 0)
  );
}

// --- The vendor call, and what a throw means --------------------------------

const fetchOrder = failable(
  async (id: string, key: string): Promise<{ id: string; total: number }> => {
    if (key.length === 0) throw new Error("no key");
    return { id, total: 42 };
  },
);

const onError: ToolErrorHandler = (err, ctx) =>
  ctx.signal.aborted
    ? toolRefusal("cancelled", "Stopped.")
    : `Could not look that up: ${String(err)}`;

// --- The tools ----------------------------------------------------------------

export const lookUpOrder = tool({
  description: "Look an order up by id.",
  inputSchema: LookupInput,
  messages,
  onError,
  execute: async ({ orderId, items }: LookupInput, ctx) => {
    const key = requireEnv(ctx, "ORDERS_API_KEY");
    const order = orFail(await fetchOrder(orderId, key));
    const last: Message | undefined = ctx.messages.at(-1);
    return { ...order, items: items ?? 0, askedBy: last?.role };
  },
});

export const endCall = tool({
  description: "Hang up.",
  execute: (_args, ctx: ToolContext) => ({ sessionId: ctx.sessionId }),
});

const PickInput = z.object({ id: z.string() });
const pickDef: ClientToolDef<typeof PickInput> = {
  description: "Pick an item on the page.",
  inputSchema: PickInput,
  timeoutMs: 5000,
};
export const pickOnPage = clientTool(pickDef);

export const tools: ToolMap = {
  look_up_order: lookUpOrder,
  end_call: endCall,
  pick_on_page: pickOnPage,
};

// --- What a spec reads off a def --------------------------------------------

export type LookupArgs = InferToolInput<typeof lookUpOrder>;
export type LookupResult = InferToolOutput<typeof lookUpOrder>;

export const handWritten: ToolDef = {
  description: "A def written out by hand, no schema.",
  execute: (args: Record<string, unknown>) => Object.keys(args).length,
};

export function classify(result: DefaultToolResult): ToolRefusalReason | "ok" {
  const failure: ToolFailure = toolFailure("No such order.");
  const refusal: ToolRefusal = toolRefusal("persona", "Not mine to answer.");
  if (isToolFailure(result)) return "reason" in result ? refusal.reason : failure.error;
  return "ok";
}

/** `orFail` handed a function wraps it; handed a value it unwraps it. */
export const guardedLookup = orFail((id: string) => Promise.resolve({ id }));
