// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 4.
 *
 * **Epoch 5 is COLLATERAL, for the third epoch running.** This file is the
 * evidence that collateral is all it was: the export list did not change at all
 * — all 93 names are the ones epoch 4 promised, byte for byte — and not one
 * helper here changed signature. What moved is the declaration they are pointed
 * AT.
 *
 * The one contributor reaches this capability the way all four of epoch 4's did,
 * through `AgentConfigSchema` (reachable from this subpath as a forgotten
 * export, which is why the hash moves at all) and `AgentConfigSource`, what
 * `expectDeployable` takes:
 *
 * - **The fast/slow two-tier split** — `AgentDef` gained an optional `twoTier`
 *   field and the schema gained the matching optional object, `.strict()` so a
 *   misspelled key inside it is a boundary error rather than a gate that fails
 *   open.
 *
 * The addition is optional, so a spec that hands `deployedAgent` an agent
 * written before `twoTier` existed still compiles, and so does one that reads
 * `expectDeployable`'s answer. That is the whole promise. If a later epoch makes
 * `twoTier` required, or narrows what `deployedAgent` accepts, this file reddens
 * — the signal to DROP the epoch rather than to edit the example.
 *
 * ## Why this file carries no roll-call, where `v3.ts` carries the longest one
 *
 * Coverage is measured per CAPABILITY over the UNION of its frozen examples, and
 * epoch 4 promised exactly the 93 names epoch 3 did — `v3.ts` names every one of
 * them and is retained alongside this file, so restating them here would freeze
 * nothing that is not already frozen. That is the same rule `tool/v2.ts` states
 * from the other side when it rolls up only `ToolErrorHandler`: a second
 * retained epoch is about what it ADDED, and epoch 4 added no name.
 *
 * What is left is the part a roll-call cannot do — an actual epoch-4 spec body,
 * exercising the two helpers the moving declaration flows through.
 *
 * **Its specifiers are RELATIVE.** Importing the package by name would resolve
 * through its own `exports` map to whatever the current build publishes, so the
 * fixture would prove the CURRENT surface compiles rather than that epoch 4's
 * does.
 *
 * @module
 */

import { z } from "zod";

import { agent, tool } from "../../../index.ts";
import type { ProjectFiles } from "../../../sdk/testing-barrel.ts";
import { deployedAgent, expectDeployable, runTool } from "../../../sdk/testing-barrel.ts";

/** An epoch-4 tool: nothing on it that epoch 5 added. */
const lookupOrder = tool({
  description: "Look up an order.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId, status: "shipped" as const }),
});

/**
 * The AUTHORED def — no `twoTier`, and no inline `tools` either: `agent()`
 * refuses a tools map, so the tools live in files and only `deployedAgent` puts
 * the two halves back together. This is the declaration whose SHAPE moved the
 * hash without moving a single name in this capability's surface.
 */
const authored = agent({
  name: "Front desk",
  systemPrompt: "Answer in one or two sentences.",
});

const project: ProjectFiles = {
  tools: { "./tools/lookup_order.ts": { default: lookupOrder } },
  systemPrompt: "Answer in one or two sentences.",
};

/** What a DEPLOYED agent runs, which is what a spec has to drive. */
const desk = deployedAgent(authored, project);

/**
 * `expectDeployable` takes the source an epoch-4 author wrote and answers with
 * the resolved config. A spec written at epoch 4 reads it field by field, and
 * epoch 5 leaves both the call and the read compiling.
 */
export function itDeploys(): string {
  return expectDeployable(authored).name;
}

/** And the tool runner, addressed through the agent, unchanged across the bump. */
export async function itRunsATool(): Promise<unknown> {
  return await runTool(desk, "lookup_order", { orderId: "A-1" });
}
