// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 example: `aai:testing`. A project's spec as it was written at epoch 1
 * — the shapes an author reached for before `deployedAgent` and
 * `stubGatewayRoute` existed.
 *
 * FROZEN, and it is a PROMISE now rather than a decoration: epoch 1 is retained
 * as supported, so `pnpm typecheck` compiling this file is the evidence that a
 * spec written against that epoch still compiles today. An error here IS the
 * finding — do not edit it to follow a change in the API. That is what a new
 * epoch is for.
 *
 * Note what it deliberately does NOT use: the def is assembled with
 * `withDiscoveredTools` alone, and the gateway fake is wired by hand. Both have
 * better spellings at epoch 2 (`deployedAgent`, which also refuses an empty tool
 * glob, and `stubGatewayRoute`, which owns the reply envelope and the URL
 * predicate). This file exists to prove the OLD way still works, not to show
 * what to write.
 *
 * The imports are relative source paths because nothing ships this file — and
 * because the claim is about the TREE: a package-name import would resolve to
 * the built surface and prove something about `dist/` instead.
 */

import { z } from "zod";
import { agent, tool } from "../../../index.ts";
import { withTools } from "../../../sdk/manifest-barrel.ts";
import {
  createToolContext,
  ok,
  parseToolInput,
  runTool,
  stubGateway,
  stubGenerate,
  type TestToolContext,
  type ToolRunner,
  toolOf,
  toolRunner,
  withDiscoveredTools,
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
 * The def a DEPLOYED agent runs, assembled the epoch-1 way.
 *
 * A project's `tools/` files are discovered by the BUILD, so a spec lowers them
 * itself. At epoch 1 that is `withDiscoveredTools` over the caller's own glob —
 * written in the spec rather than reached for from a helper, because a shared
 * one does not exist in a scaffolded project.
 */
export function deployed(modules: Record<string, unknown>): typeof desk {
  return withDiscoveredTools(desk, modules);
}

/** A tool driven directly, with a context whose collaborators are inert. */
export async function callTheTool(def: typeof desk): Promise<string> {
  const ctx: TestToolContext = createToolContext({ env: { SOME_TOKEN: "t" } });
  // The schema the AGENT holds, asked what it accepts — which is why this takes
  // the def and a name rather than the tool value.
  const parsed = await parseToolInput<{ orderId: string }>(def, "look_up", {
    orderId: "W1234",
  });
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
 * The gateway fake, wired BY HAND — the epoch-1 spelling.
 *
 * The reply envelope and the URL predicate are the caller's business here, which
 * is exactly what made seven copies of this diverge (one matched a host, six a
 * path). Epoch 2 has `stubGatewayRoute`; this is what it replaced.
 */
export function scriptTheGateway(content: string): { calls: readonly unknown[] } {
  const model = stubGateway(content);
  return { calls: model.calls };
}
