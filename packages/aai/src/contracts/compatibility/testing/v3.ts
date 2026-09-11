// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 3.
 *
 * Epoch 4 changed nothing in the test helpers. What moved is `ToolDef`, which
 * gained an optional `messages` field — the agent's speech around a tool
 * call — and half this surface is typed in terms of tools: `toolOf`/`runTool`
 * reach one by the name the model calls it by, `createToolContext` builds what
 * its `execute` is handed, and `deployedAgent` assembles the def a deployed
 * agent runs.
 *
 * The promise is that a project's own spec, written at epoch 3, still
 * compiles: build a context with the inert defaults, run a tool through the
 * name the model uses, and read back what the tool sent.
 *
 * Coverage is per capability over the union of frozen examples, and `v2.ts`
 * already names all ninety-three of this one's exports, so this file is about
 * the transition rather than a roll-call. Its specifiers are RELATIVE, so it
 * proves epoch 3's surface compiles rather than the current build's.
 *
 * @module
 */

import { z } from "zod";

import { agent, tool } from "../../../index.ts";
import type { TestToolContext } from "../../../sdk/testing.ts";
import { createToolContext, deployedAgent, runTool, toolOf } from "../../../sdk/testing.ts";

const greetTool = tool({
  description: "Greet the caller by name.",
  inputSchema: z.object({ name: z.string() }),
  execute: ({ name }, ctx) => {
    ctx.send("greeted", { name });
    return { greeting: `Hello, ${name}.` };
  },
});

/**
 * The def a DEPLOYED agent runs, assembled from an `agent.ts` plus the tool
 * FILES beside it — which is the only way a project whose tools are files can
 * reach them from a spec.
 */
const deployed = deployedAgent(agent({ name: "Greeter" }), {
  tools: { "tools/greet.ts": { default: greetTool } },
});

/** A context with the inert defaults, and the recording `send` it carries. */
export async function greetsAndAnnounces(): Promise<string[]> {
  const ctx: TestToolContext = createToolContext();
  await runTool(deployed, "greet", { name: "Ada" }, ctx);
  // And the same tool reached directly, by the name the model calls it by.
  await toolOf(deployed, "greet").execute({ name: "Grace" }, ctx);
  return ctx.sent.map((event) => event.event);
}
