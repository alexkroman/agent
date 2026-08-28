// Copyright 2026 the AAI authors. MIT license.
/**
 * FROZEN authoring example — `aai:testing`, epoch 6.
 *
 * Moved with the `AgentParams` split. The testing surface is unchanged and
 * epoch 6 is RETAINED: this is how a tool was tested from a user's project.
 */

import { z } from "zod";
import { agent, type ToolContext, tool } from "../../../index.ts";
import { createToolContext, runTool, toolOf } from "../../../sdk/testing.ts";

const priceOf = tool({
  description: "Price a SKU",
  inputSchema: z.object({ sku: z.string() }),
  execute: ({ sku }) => ({ sku, price: 42 }),
});

const def = agent({ name: "Shop" });

/** The inert context, and the overrides a spec supplies. */
export function contexts(): [ToolContext, ToolContext] {
  return [createToolContext(), createToolContext({ sessionId: "s-1", env: { SHOP: "on" } })];
}

/** Running a tool through the registry, the epoch-6 way. */
export async function run(): Promise<unknown> {
  const withTool = { ...def, tools: { price_of: priceOf } };
  const found = toolOf(withTool, "price_of");
  void found;
  return await runTool(withTool, "price_of", { sku: "abc" }, createToolContext());
}
