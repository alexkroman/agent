// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 7.
 *
 * **Epoch 8 is COLLATERAL, for the sixth epoch running** — and this time it is
 * collateral TWICE, from one change. No name left this capability and no
 * helper changed signature. What moved is two declarations the helpers point
 * at: `BuiltinTool` gained an eleventh member (`"listen_for"`), and
 * `ToolContext` gained a required field (`steerRecognizer`), which reaches
 * here because `createToolContext` RETURNS one.
 *
 * The second is the one worth pinning, because it is the half that could have
 * broken every spec in a user's project while their agent kept running. A
 * required field on a context is fine for a tool BODY, which only reads it —
 * but a spec DRIVES a tool, and if the published helper had not learned the
 * field at the same moment, every `runTool` call would have stopped
 * compiling. The promise this file makes is therefore precise: an epoch-7
 * spec still builds a context with no arguments, and still passes it to a
 * tool, because supplying the new member is the HELPER's job.
 *
 * What it does not promise, deliberately: a spec that builds a `ToolContext`
 * as an object literal of its own. That never worked across a context change
 * and is the exact shape `createToolContext` exists to replace — its own doc
 * has said so since epoch 1.
 *
 * ## Why this file carries no roll-call
 *
 * Coverage is measured per CAPABILITY over the UNION of its frozen examples,
 * and epoch 7 promised the names epoch 3 did; `v3.ts` names every one and is
 * retained alongside this file. What is left is the part a roll-call cannot
 * do: an actual epoch-7 spec body, driving the helpers the moved declarations
 * flow through.
 *
 * **Its specifiers are RELATIVE.** Importing the package by name would resolve
 * through its own `exports` map to whatever the current build publishes, so
 * the file would prove the CURRENT surface compiles rather than epoch 7's.
 *
 * @module
 */

import { z } from "zod";

import { agent, tool } from "../../../index.ts";
import type { ProjectFiles } from "../../../sdk/testing-barrel.ts";
import {
  createToolContext,
  deployedAgent,
  expectDeployable,
  runTool,
} from "../../../sdk/testing-barrel.ts";

/** An ordinary epoch-7 tool, reading the context the way a tool body does. */
const lookupOrder = tool({
  description: "Look up an order.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: ({ orderId }, ctx) => ({
    orderId,
    status: "shipped" as const,
    session: ctx.sessionId,
  }),
});

/**
 * The context, built with NO arguments — the call every epoch-7 spec makes,
 * and the one a new required field would have broken had the helper not
 * supplied it.
 */
export const ctx = createToolContext();

/** And with overrides, the other shape a spec uses. */
export const seeded = createToolContext({ env: { ORDER_REGION: "eu" }, sessionId: "s-1" });

/** Driving the tool by the name the model calls it by, on a DEPLOYED def. */
const project: ProjectFiles = {
  tools: { "./tools/lookup_order.ts": { default: lookupOrder } },
  systemPrompt: "Answer in one or two sentences.",
};

export async function run(): Promise<unknown> {
  const desk = deployedAgent(
    agent({ name: "Front desk", systemPrompt: "Answer in one or two sentences." }),
    project,
  );
  return await runTool(desk, "lookup_order", { orderId: "W1" }, ctx);
}

/**
 * The builtins half: an agent naming them from the ten that existed at epoch
 * 7, validated the way an epoch-7 spec validated it.
 */
const authored = agent({
  name: "Front desk",
  systemPrompt: "Answer in one or two sentences.",
  builtinTools: ["think", "calculate", "verify_action"],
});

/** Reading `builtinTools` back off the resolved config — the field that moved. */
export const enabled: readonly string[] = expectDeployable(authored).builtinTools ?? [];
