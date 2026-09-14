// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 6.
 *
 * **Epoch 7 is COLLATERAL, for the fifth epoch running.** The export list did
 * not change — every name epoch 6 promised is still here — and not one helper
 * changed signature. What moved is a declaration they are pointed AT:
 * `BuiltinTool` gained a tenth member (`"verify_action"`), reaching this
 * capability through `AgentConfigSchema` and `AgentConfigSource`, the source
 * `expectDeployable` takes.
 *
 * So the promise is narrow and worth stating exactly: a SPEC written at epoch 6
 * against an agent that names builtins still compiles, and still reads the
 * resolved config back. A widened union satisfies that; a renamed member, or a
 * `deployedAgent` that stopped accepting an agent with builtins, would not.
 *
 * ## Why this file carries no roll-call, where `v3.ts` carries the longest one
 *
 * Coverage is measured per CAPABILITY over the UNION of its frozen examples,
 * and epoch 6 promised exactly the names epoch 3 did — `v3.ts` names every one
 * and is retained alongside this file. Restating them here would freeze nothing
 * that is not already frozen, the same rule `v4.ts` states from the other side.
 *
 * What is left is the part a roll-call cannot do: an actual epoch-6 spec body,
 * driving the helpers the moving declaration flows through.
 *
 * **Its specifiers are RELATIVE.** Importing the package by name would resolve
 * through its own `exports` map to whatever the current build publishes, so the
 * fixture would prove the CURRENT surface compiles rather than that epoch 6's
 * does.
 *
 * @module
 */

import { z } from "zod";

import { agent, tool } from "../../../index.ts";
import type { ProjectFiles } from "../../../sdk/testing-barrel.ts";
import { deployedAgent, expectDeployable, runTool } from "../../../sdk/testing-barrel.ts";

/** An ordinary epoch-6 tool, living in a file the way every tool does. */
const lookupOrder = tool({
  description: "Look up an order.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId, status: "shipped" as const }),
});

/**
 * The AUTHORED def, naming builtins from the nine that existed at epoch 6.
 * This is the declaration whose SHAPE moved the hash without moving a name in
 * this capability's surface, so it is the one a frozen spec has to hold.
 */
const authored = agent({
  name: "Front desk",
  systemPrompt: "Answer in one or two sentences.",
  builtinTools: ["think", "calculate"],
});

/**
 * No inline `tools`: `agent()` refuses a tools map, so the tools live in files
 * and only `deployedAgent` puts the two halves back together.
 */
const project: ProjectFiles = {
  tools: { "./tools/lookup_order.ts": { default: lookupOrder } },
  systemPrompt: "Answer in one or two sentences.",
};

/** What a DEPLOYED agent runs, which is what a spec has to drive. */
const desk = deployedAgent(authored, project);

/**
 * `expectDeployable` validates the source an epoch-6 author wrote and answers
 * with the resolved config. Reading `builtinTools` off that answer is the read
 * epoch 7's widening has to leave standing — it is the field that moved.
 */
export function itDeploysWithBuiltins(): readonly string[] {
  return expectDeployable(authored).builtinTools ?? [];
}

/** And the tool runner, addressed through the agent, unchanged across the bump. */
export async function itRunsATool(): Promise<unknown> {
  return await runTool(desk, "lookup_order", { orderId: "A-1" });
}
