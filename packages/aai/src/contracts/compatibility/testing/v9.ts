// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 9.
 *
 * **Epoch 10 is COLLATERAL.** The export list did not change — all 93 names are
 * the ones epoch 9 promised — and not one helper here changed signature. What
 * moved is the declaration they are pointed AT: `AgentDef` gained an optional
 * `personas` field (a roster of speakers; `aai:persona` is its own contract),
 * and `HOST_ONLY_AGENT_FIELDS`, reachable from this subpath through
 * `AgentConfigSchema`, gained the matching entry. Both reach this capability
 * through `AgentConfigSource`, what `expectDeployable` takes, and through
 * `ToolBearingAgent`, what `deployedAgent` and `toolRunner` take.
 *
 * ## Why this file carries no roll-call
 *
 * `v2.ts` through `v8.ts` are retained and between them name every one of the
 * 93, and epoch 9 added no name to epoch 8's list. What is left is the part a
 * roll-call cannot do — an actual epoch-9 spec body over the helpers the moving
 * declaration flows through, written for an agent that declares no roster.
 *
 * **Its specifiers are RELATIVE.** Importing the package by name would resolve
 * through its own `exports` map to whatever the current build publishes, so the
 * fixture would prove the CURRENT surface compiles rather than that epoch 9's
 * does.
 *
 * @module
 */

import { z } from "zod";

import { agent, tool } from "../../../index.ts";
import type { ProjectFiles, TestToolContext } from "../../../sdk/testing-barrel.ts";
import {
  createToolContext,
  deployedAgent,
  expectDeployable,
  toolRunner,
} from "../../../sdk/testing-barrel.ts";

/** An epoch-9 tool: reads the context it is handed, and nothing newer. */
const lookupOrder = tool({
  description: "Look up an order.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: ({ orderId }, ctx) => ({ orderId, session: ctx.sessionId }),
});

/**
 * The AUTHORED def — no `personas`, and no inline `tools` either: `agent()`
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

/** `expectDeployable` takes what an epoch-9 author wrote and answers the resolved config. */
export function itDeploys(): string {
  return expectDeployable(authored).name;
}

/** The runner bound to the agent, and the context it is handed, unchanged across the bump. */
export async function itRunsATool(): Promise<unknown> {
  const ctx: TestToolContext = createToolContext();
  const run = toolRunner(desk);
  return await run("lookup_order", { orderId: "A-1" }, ctx);
}
