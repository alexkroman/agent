// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-2 example: `aai:testing`. A project's spec as it was written at epoch 2
 * — `deployedAgent` for the def, `stubGatewayRoute` for the gateway, and a tool
 * context built before {@link SessionEventContext} could reach a slot.
 *
 * FROZEN, and a PROMISE rather than a decoration: epoch 2 is retained as
 * supported, so `pnpm typecheck` compiling this file is the evidence that a spec
 * written at that epoch still compiles. An error here IS the finding — do not
 * edit it to follow a change in the API. That is what a new epoch is for.
 *
 * What moved at epoch 3 is a type this surface REACHES rather than one it names:
 * `SessionEventContext` gained `slots`, and API Extractor rolls up forgotten
 * exports, so it lands in this capability's report. Nothing a spec writes
 * changed, which is what the lines below are here to hold.
 *
 * See `v1.ts` for the epoch-1 spellings these replaced — that file exists to
 * prove the older way still works, and so does this one.
 *
 * The imports are relative source paths for the reason `state/v1.ts` gives.
 */

import { z } from "zod";
import { agent, tool } from "../../../index.ts";
import { withTools } from "../../../sdk/manifest-barrel.ts";
import {
  createToolContext,
  createUnusedDb,
  deployedAgent,
  ok,
  type ProjectFiles,
  parseToolInput,
  runTool,
  type StubGatewayRoute,
  stubGatewayRoute,
  stubGenerate,
  type TestToolContext,
  type ToolRunner,
  toolOf,
  toolRunner,
} from "../../../sdk/testing.ts";

/** A tool, as a project writes one. */
const lookUp = tool({
  description: "Look up an order.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId, status: "shipped" }),
});

/** The agent under test, with its tool attached the way a project's build does. */
export const desk = withTools(agent({ name: "Order Desk", greeting: "Order support." }), {
  look_up: lookUp,
});

/**
 * The def a DEPLOYED agent runs, assembled the epoch-2 way.
 *
 * `deployedAgent` over a `ProjectFiles` bag rather than `withDiscoveredTools`
 * over a bare module map: it carries the system prompt too, and it REFUSES an
 * empty tool glob — the failure that used to read as an agent with no tools.
 */
export function deployed(files: ProjectFiles): typeof desk {
  return deployedAgent(desk, files);
}

/** A tool driven directly, with a context whose collaborators are inert. */
export async function callTheTool(def: typeof desk): Promise<string> {
  const ctx: TestToolContext = createToolContext({
    env: { SOME_TOKEN: "t" },
    db: createUnusedDb(),
  });
  const parsed = await parseToolInput<{ orderId: string }>(def, "look_up", { orderId: "W1234" });
  const answer = await toolOf(def, "look_up").execute(parsed, ctx);
  return ok<{ status: string }>(answer).status;
}

/** The same thing through the agent's own table, which is what a spec does. */
export async function callThroughTheAgent(def: typeof desk): Promise<unknown> {
  const run: ToolRunner = toolRunner(def);
  return await run("look_up", { orderId: "W1234" });
}

/** One-off, without holding a runner. */
export async function callOnce(def: typeof desk): Promise<unknown> {
  return await runTool(def, "look_up", { orderId: "W1234" });
}

/** A tool that reasons with a model, driven on a scripted `ctx.generate`. */
export async function gradeSomething(): Promise<boolean> {
  const model = stubGenerate({ text: "yes" });
  const ctx = createToolContext({ generate: model.generate });
  const graded = await ctx.generate({ prompt: "is this grounded?" });
  return graded.text.includes("yes");
}

/**
 * The gateway fake, epoch 2's spelling: the route owns the reply envelope and
 * the URL predicate, so a spec no longer writes either.
 */
export function scriptTheGateway(content: string): StubGatewayRoute {
  return stubGatewayRoute(content, { status: 200 });
}
