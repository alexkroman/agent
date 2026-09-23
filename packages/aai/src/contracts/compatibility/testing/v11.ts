// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 11.
 *
 * **Epoch 12 is COLLATERAL.** The export list did not change and no helper
 * here changed signature. What moved is the declaration they are pointed AT:
 * `AgentDef.events` is keyed on the session event vocabulary, which gained
 * `"metrics.collected"`, and that reaches this capability through
 * `AgentConfigSource` (what `expectDeployable` takes) and `ToolBearingAgent`
 * (what `deployedAgent` and `toolRunner` take).
 *
 * `v2.ts` through `v10.ts` name every one of this capability's exports and
 * epoch 11 added none, so this is a spec body rather than a roll-call: an
 * epoch-11 agent — push-to-talk, with an `events` map — driven through the
 * helpers the moving declaration flows through.
 *
 * **Its specifiers are RELATIVE**, for the reason every frozen example's are.
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
  toolRunner,
} from "../../../sdk/testing-barrel.ts";

const lookupOrder = tool({
  description: "Look up an order.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId }),
});

/** An epoch-11 def: push-to-talk, an `events` map on epoch-11 keys, tools in files. */
const authored = agent({
  name: "Front desk",
  systemPrompt: "Answer in one or two sentences.",
  turnDetection: "manual",
  events: { "tool.called": () => undefined },
});

const project: ProjectFiles = {
  tools: { "./tools/lookup_order.ts": { default: lookupOrder } },
  systemPrompt: "Answer in one or two sentences.",
};

export function itDeploys(): string {
  return expectDeployable(authored).name;
}

export async function itRunsATool(): Promise<unknown> {
  const run = toolRunner(deployedAgent(authored, project));
  return await run("lookup_order", { orderId: "A-1" }, createToolContext());
}
