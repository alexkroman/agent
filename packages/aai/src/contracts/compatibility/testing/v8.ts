// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 8.
 *
 * **Epoch 9 is COLLATERAL, as epochs 3, 4 and 5 were.** The export list did not
 * change — all 93 names are the ones epoch 8 promised — and no helper here
 * changed signature. What moved is two declarations they are pointed AT, both
 * from `AgentDef.userTurnLimit` landing in the same release:
 *
 * - **`AgentConfigSchema`** gained the optional `userTurnLimit` object (reachable
 *   from this subpath as a forgotten export, which is why the hash moves at all),
 *   and with it `AgentConfigSource`, what `expectDeployable` takes.
 * - **`SessionEvent`** gained `user-turn.exceeded`, which the event-stream
 *   helpers (`SentEvent`, `StubEmitted`) are typed over.
 *
 * Both additions are optional or additive, so a spec that hands `deployedAgent`
 * an agent written before the cap existed still compiles, and so does one that
 * reads `expectDeployable`'s answer or matches on an epoch-8 event name. That is
 * the whole promise. If a later epoch makes `userTurnLimit` required, narrows
 * what `deployedAgent` accepts, or removes an event name, this file reddens —
 * the signal to DROP the epoch rather than to edit the example.
 *
 * Coverage of epoch 8's 93 names is carried by `v2`–`v4`, the three retained
 * examples beside this one; a capability with several retained epochs splits
 * its surface between them and coverage is measured over the union
 * (`api-contracts-gate.test.ts`). This file therefore repeats none of the
 * roll-call and shows only the two calls the collateral reached.
 *
 * @module
 */

import { z } from "zod";

import { agent, tool } from "../../../index.ts";
import type { ProjectFiles } from "../../../sdk/testing-barrel.ts";
import { deployedAgent, expectDeployable, runTool } from "../../../sdk/testing-barrel.ts";

/** An epoch-8 tool: nothing on it that epoch 9 touched. */
const checkStock = tool({
  description: "Check whether an item is in stock.",
  inputSchema: z.object({ sku: z.string() }),
  execute: ({ sku }) => ({ sku, inStock: true as const }),
});

/**
 * The AUTHORED def — no `userTurnLimit`: an epoch-8 caller's turn ended only
 * when the transcriber's silence window said so. This is the declaration whose
 * SHAPE moved the hash without moving a single name in this capability.
 */
const authored = agent({
  name: "Stock desk",
  systemPrompt: "Check before you promise.",
});

const project: ProjectFiles = {
  tools: { "./tools/check_stock.ts": { default: checkStock } },
  systemPrompt: "Check before you promise.",
};

/** What a DEPLOYED agent runs, which is what a spec has to drive. */
const desk = deployedAgent(authored, project);

/** `expectDeployable` still takes what an epoch-8 author wrote, and still answers a config. */
export function itDeploys(): string {
  return expectDeployable(authored).name;
}

/** And the tool runner, addressed through the agent, unchanged across the bump. */
export async function itRunsATool(): Promise<unknown> {
  return await runTool(desk, "check_stock", { sku: "A-1" });
}
