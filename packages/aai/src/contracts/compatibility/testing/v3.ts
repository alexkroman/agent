// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 3.
 *
 * **Nothing in this capability's own surface changed at epoch 4.** The hash
 * moved because `deployedAgent` carries `AgentConfigSchema` into this
 * entrypoint's rollup, and that schema gained one optional key —
 * `lowConfidence`, the policy `agent({ lowConfidence })` accepts. Every helper
 * here has the signature it had.
 *
 * So the promise is that a spec written at epoch 3 still compiles, including
 * one that builds a config-bearing agent. If a later epoch changes a helper's
 * signature, this file reddens — the signal to DROP the epoch rather than to
 * edit the example.
 *
 * The 93 names epoch 3 promised are already imported and used by `v2.ts`
 * beside this file, and the gate's coverage rule reads the UNION of a
 * capability's frozen examples; restating them would be a copy that can drift
 * rather than a second proof. Specifiers are RELATIVE, like every fixture
 * here.
 *
 * @module
 */

import { agent, tool } from "../../../index.ts";
import { createToolContext, deployedAgent, runTool } from "../../../sdk/testing.ts";

const greet = tool({
  description: "Greet the caller by name.",
  execute: ({ name }: { name: string }) => `Hello, ${name}.`,
});

/** The def a DEPLOYED agent runs: the inline declaration plus its tool files. */
export const deployed = deployedAgent(agent({ name: "Front desk", systemPrompt: "Be brief." }), {
  tools: { "./tools/greet.ts": { default: greet } },
});

/** One tool, reached by the name the model calls it by, on a full context. */
export async function greetsByName(): Promise<string> {
  const ctx = createToolContext();
  return String(await runTool(deployed, "greet", { name: "Ada" }, ctx));
}
