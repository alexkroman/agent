// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `testing` epoch 10.
 *
 * Epoch 10 added the fakes a tool's COLLABORATORS are driven by — a model
 * (`stubGenerate`), a run snapshot and its progress channel, the agent's own
 * tool table — plus `installStubGateway` on the `/vitest` subpath, which is the
 * same fake as epoch 7's with the `vi.stubGlobal` done for you. Everything
 * epoch 9 could express still compiles (see `./v9.ts`, retained for that
 * reason); this file covers only what is new.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. `installStubGateway` is deliberately NOT imported here: it pulls
 * `vitest`, and a compatibility fixture is compiled by `tsc`, not run — its own
 * epoch is proved by `../../../sdk/testing-vitest.ts` continuing to type-check.
 */

import type { ToolInputSchema } from "../../../sdk/schema.ts";
import {
  createProgressStream,
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  type RunSnapshotOverrides,
  runTool,
  type StubGenerate,
  type StubGenerateCall,
  type StubGenerateReply,
  type StubGenerateRoute,
  stubGenerate,
  type ToolBearingAgent,
  toolOf,
} from "../../../sdk/testing.ts";
import type { ToolDef } from "../../../sdk/types.ts";

type CartState = { items: string[] };

const GRADER = "You grade documents.";

const addItemTool: ToolDef<ToolInputSchema, CartState> = {
  description: "Add an item",
  execute: (args, ctx) => ({ added: args.item, session: ctx.sessionId }),
};

const agentDef: ToolBearingAgent<CartState> = { tools: { add_item: addItemTool } };

/** A tool reached by the name the model calls it by. */
export function describeTool(): string {
  return toolOf(agentDef, "add_item").description;
}

/** …and run against a context. */
export async function addItem(): Promise<unknown> {
  return await runTool(agentDef, "add_item", { item: "widget" }, createToolContext<CartState>());
}

/** A scripted `ctx.generate`, routed by system prompt. */
export async function gradeOne(): Promise<StubGenerateCall[]> {
  const route: StubGenerateRoute = (call: StubGenerateCall): StubGenerateReply => ({
    object: { score: "yes", of: call.prompt },
  });
  const model: StubGenerate = stubGenerate({ [GRADER]: route });
  const ctx = createToolContext<CartState>({ generate: model.generate });
  await ctx.generate({ system: GRADER, prompt: "D1" });
  return model.calls;
}

/** One route for every call, which is what a one-model tool wants. */
export async function answerAnything(): Promise<string> {
  const model = stubGenerate("The documented answer.");
  return (await model.generate({ prompt: "anything" })).text;
}

/** A run snapshot that narrows without a cast, and its progress channel. */
export function finishedRun(): { sources: number } | undefined {
  const over: RunSnapshotOverrides<{ sources: number }> = {
    workflow: "research",
    status: "completed",
    output: { sources: 3 },
  };
  const run = createRunSnapshot(over);
  return run.status === "completed" ? run.output : undefined;
}

export function workflowsAnsweringProgress(): ReturnType<typeof createStubWorkflows> {
  return createStubWorkflows({
    get: () => Promise.resolve(createRunSnapshot({ status: "running" })),
    streamTail: () => Promise.resolve(0),
    stream: () => Promise.resolve(createProgressStream(["Reading the sources…"])),
  });
}
