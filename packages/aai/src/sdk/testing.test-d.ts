// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level contract of the `@alexkroman1/aai/testing` script positions — what
 * a spec may hand `generate` and `delegate`, and the shapes it may not.
 *
 * A script is `{ reply }` or `{ routes }`, NAMED. The bare form it replaced — a
 * route table or a lone reply, told apart at run time by the reply's shape —
 * type-checked `{ text: "…" }` as a table with one route named `text`, and the
 * misuse arm meant to refuse it could not make `tsc` print its rule. A claim
 * about what does NOT compile belongs here, stated positively, where it is
 * counted by nothing — the same argument `_session-slot-caps.test-d.ts` makes.
 */
import { expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { ToolContextOverrides } from "./_testing-context.ts";
import { createToolContext } from "./_testing-context.ts";
import { expectToolOk } from "./_testing-tool-results.ts";
import { tool } from "./define.ts";
import type { DialogToolResult } from "./dialog-types.ts";
import type { StubDelegateScript } from "./testing-delegate.ts";
import type { DeployedConfig } from "./testing-deployable.ts";
import type { StubGenerateScript } from "./testing-generate.ts";
import { type fireEvent, sessionEvent } from "./testing-session-events.ts";
import { runTool, toolRunner } from "./testing-tools.ts";
import { createRunSnapshot } from "./testing-workflows.ts";
import type { ToolContext } from "./types.ts";
import { type ToolFailure, toolFailure } from "./utils.ts";
import { workflow } from "./workflow.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

test("a script names its shape: one `reply`, or a table of `routes`", () => {
  expectTypeOf<{ reply: string }>().toExtend<StubGenerateScript>();
  expectTypeOf<{ reply: { object: unknown } }>().toExtend<StubGenerateScript>();
  expectTypeOf<{ reply: { text: string; object: unknown } }>().toExtend<StubGenerateScript>();
  expectTypeOf<{ reply: () => string }>().toExtend<StubGenerateScript>();
  expectTypeOf<{ routes: { "You grade documents.": string } }>().toExtend<StubGenerateScript>();
  expectTypeOf<{ reply: string }>().toExtend<StubDelegateScript>();
  expectTypeOf<{ routes: { researcher: { text: string } } }>().toExtend<StubDelegateScript>();
});

test("the bare shapes are not scripts, and neither is naming both", () => {
  expectTypeOf<string>().not.toExtend<StubGenerateScript>();
  expectTypeOf<{ text: string }>().not.toExtend<StubGenerateScript>();
  expectTypeOf<{ object: unknown }>().not.toExtend<StubGenerateScript>();
  expectTypeOf<{ "You grade documents.": string }>().not.toExtend<StubGenerateScript>();
  expectTypeOf<{ reply: string; routes: { a: string } }>().not.toExtend<StubGenerateScript>();
  expectTypeOf<string>().not.toExtend<StubDelegateScript>();
  expectTypeOf<{ researcher: string }>().not.toExtend<StubDelegateScript>();
});

test("every position that takes a script takes the same two shapes", () => {
  expectTypeOf<{ generate: { reply: string } }>().toExtend<ToolContextOverrides>();
  expectTypeOf<{ generate: { routes: { s: string } } }>().toExtend<ToolContextOverrides>();
  expectTypeOf<{ delegate: { reply: string } }>().toExtend<ToolContextOverrides>();
  expectTypeOf<{ generate: string }>().not.toExtend<ToolContextOverrides>();
});

test("a FUNCTION in the context's `generate` is the seam, and a route function is not", () => {
  // A computed route is `{ reply: (call) => … }`, so a bare function here can
  // only be the seam — and one returning a bare string is not a `GenerateFn`.
  expectTypeOf<{
    generate: () => Promise<{ text: string; object: unknown }>;
  }>().toExtend<ToolContextOverrides>();
  expectTypeOf<{ generate: () => string }>().not.toExtend<ToolContextOverrides>();
  expectTypeOf<{ generate: { reply: () => string } }>().toExtend<ToolContextOverrides>();
});

test("the overrides NAME every ToolContext field, and no other", () => {
  // `ToolContextOverrides` spells its fields out rather than mapping over
  // `keyof ToolContext`; this is what keeps the two in step. A field added to
  // `ToolContext` fails the first assertion until a spec can override it.
  // `clientId`/`clientPhone`/`clientLocation` are not fields: each seeds its `sessionClient*`,
  // and `call` seeds `sessionCall`.
  type Own = Exclude<
    keyof ToolContextOverrides,
    "model" | "desk" | "clientId" | "clientPhone" | "clientLocation" | "call"
  >;
  expectTypeOf<Exclude<keyof ToolContext, Own>>().toEqualTypeOf<never>();
  expectTypeOf<Exclude<Own, keyof ToolContext>>().toEqualTypeOf<never>();
});

test("runTool takes the TOOL and is typed end to end; a name is not a tool", async () => {
  const addItem = tool({
    description: "Add an item",
    inputSchema: z.object({ item: z.string() }),
    execute: async ({ item }) => ({ added: item, count: 1 }),
  });
  const ctx = createToolContext();
  expectTypeOf(await runTool(addItem, { item: "apple" }, ctx)).toEqualTypeOf<{
    added: string;
    count: number;
  }>();
  // The context may stand in for the arguments.
  expectTypeOf(runTool(addItem, ctx)).resolves.toEqualTypeOf<{ added: string; count: number }>();
  // The arguments are checked against what `execute` takes.
  expectTypeOf<{ item: number }>().not.toExtend<Parameters<typeof runTool<typeof addItem>>[1]>();
  // Matched on `execute` alone: a bare object with one is a tool too.
  const bare = { execute: (args: { n: number }) => args.n * 2 };
  expectTypeOf(await runTool(bare, { n: 2 })).toEqualTypeOf<number>();
  // The tool position takes a DEF: neither an agent nor the tool's name is one.
  expectTypeOf<string>().not.toExtend<Parameters<typeof runTool>[0]>();
  expectTypeOf<{ tools: Record<string, typeof addItem> }>().not.toExtend<
    Parameters<typeof runTool>[0]
  >();
});

test("expectToolOk infers: a plain result loses its failure arm, an envelope is unwrapped", async () => {
  const lookUp = tool({
    description: "Look an order up",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => (id ? { id, total: 3 } : toolFailure("Which order?")),
  });
  expectTypeOf(expectToolOk(await runTool(lookUp, { id: "o1" }))).toEqualTypeOf<{
    id: string;
    total: number;
  }>();
  const gated = (envelope: DialogToolResult<{ quoted: number }> | ToolFailure) =>
    expectToolOk(envelope);
  expectTypeOf(gated).returns.toEqualTypeOf<{ quoted: number }>();
  // There is no CLAIMED form: a written type argument is the parameter's type,
  // so `expectToolOk<{ id: string }>(x)` compiles only when `x` already is one…
  expectTypeOf<Parameters<typeof expectToolOk<{ id: string }>>[0]>().toEqualTypeOf<{
    id: string;
  }>();
  expectTypeOf<unknown>().not.toExtend<Parameters<typeof expectToolOk<{ id: string }>>[0]>();
  // …and an `unknown` result stays `unknown` rather than inventing a shape.
  const bare = (answered: unknown) => expectToolOk(answered);
  expectTypeOf(bare).returns.toBeUnknown();
});

test("expectDeployable's config names only what the specs read — not the config schema", () => {
  expectTypeOf<DeployedConfig["mode"]>().toEqualTypeOf<
    "pipeline" | "s2s" | "text" | "workflow-app"
  >();
  expectTypeOf<DeployedConfig["name"]>().toEqualTypeOf<string>();
  expectTypeOf<DeployedConfig["systemPrompt"]>().toEqualTypeOf<string>();
});

test("a runner takes the DEF and is typed end to end; the tool's name is not a tool", async () => {
  const addItem = tool({
    description: "Add an item",
    inputSchema: z.object({ item: z.string() }),
    execute: async ({ item }) => ({ added: item, count: 1 }),
  });
  const run = toolRunner({ tools: { add_item: addItem } });
  expectTypeOf(await run(addItem, { item: "apple" })).toEqualTypeOf<{
    added: string;
    count: number;
  }>();
  // The context may stand in for the arguments.
  expectTypeOf(run(addItem, createToolContext())).resolves.toEqualTypeOf<{
    added: string;
    count: number;
  }>();
  // A dialog-shaped def keeps its envelope type.
  const gated = {
    execute: async (_args: {
      id: string;
    }): Promise<DialogToolResult<{ quoted: number }> | ToolFailure> => toolFailure("no"),
  };
  expectTypeOf(expectToolOk(await run(gated, { id: "o1" }))).toEqualTypeOf<{ quoted: number }>();
  // A string in the tool position is a compile error: a name is not a def.
  expectTypeOf<string>().not.toExtend<Parameters<typeof run>[0]>();
});

test("createRunSnapshot handed the def types `output` by it", () => {
  const recap = workflow({
    description: "Recap",
    run: async () => ({ headline: "H" }),
  });
  const done = createRunSnapshot(recap, { status: "completed", output: { headline: "H" } });
  expectTypeOf(done).toExtend<WorkflowRunSnapshot<{ headline: string }>>();
  expectTypeOf<Extract<typeof done, { status: "completed" }>["output"]>().toEqualTypeOf<{
    headline: string;
  }>();
  // An output the def's body does not return is a compile error in the fixture.
  expectTypeOf<{ status: "completed"; output: { headline: number } }>().not.toExtend<
    Parameters<typeof createRunSnapshot<{ headline: string }>>[0]
  >();
  // The bare form still infers `R` from the overrides alone.
  const bare = createRunSnapshot({ status: "completed", output: 1 });
  expectTypeOf<Extract<typeof bare, { status: "completed" }>["output"]>().toEqualTypeOf<number>();
});

test("sessionEvent types the fields by the name, and an envelope-only event takes none", () => {
  const committed = sessionEvent("userTranscript.committed", { text: "hi" });
  expectTypeOf(committed.type).toEqualTypeOf<"userTranscript.committed">();
  expectTypeOf(committed.text).toEqualTypeOf<string>();
  expectTypeOf(sessionEvent("reply.completed").type).toEqualTypeOf<"reply.completed">();
  // A field the event does not declare is a compile error at the call.
  expectTypeOf<Parameters<typeof sessionEvent<"userTranscript.committed">>[1]>().not.toExtend<{
    toolName: string;
  }>();
  // And a tool context is a session event context, so the handler reads a slot through it.
  expectTypeOf(createToolContext()).toExtend<Parameters<typeof fireEvent>[2]>();
});
