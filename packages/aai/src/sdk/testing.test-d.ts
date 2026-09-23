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
import { tool } from "./define.ts";
import type { StubDelegateScript } from "./testing-delegate.ts";
import type { DeployedConfig } from "./testing-deployable.ts";
import type { StubGenerateScript } from "./testing-generate.ts";
import type { ScriptedToolContextOptions } from "./testing-scripted.ts";
import { runTool } from "./testing-tools.ts";
import type { ToolContext } from "./types.ts";

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
  expectTypeOf<{ generate: { reply: string } }>().toExtend<ScriptedToolContextOptions>();
  expectTypeOf<{ delegate: { routes: { r: string } } }>().toExtend<ScriptedToolContextOptions>();
  expectTypeOf<{ generate: string }>().not.toExtend<ToolContextOverrides>();
  expectTypeOf<{ generate: string }>().not.toExtend<ScriptedToolContextOptions>();
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
  type Own = Exclude<keyof ToolContextOverrides, "model" | "desk">;
  expectTypeOf<Exclude<keyof ToolContext, Own>>().toEqualTypeOf<never>();
  expectTypeOf<Exclude<Own, keyof ToolContext>>().toEqualTypeOf<never>();
});

test("runTool handed the TOOL is typed end to end; by name it answers unknown", async () => {
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
  // The context may stand in for the arguments, as in the name form.
  expectTypeOf(runTool(addItem, ctx)).resolves.toEqualTypeOf<{ added: string; count: number }>();
  // The arguments are checked against what `execute` takes.
  expectTypeOf<{ item: number }>().not.toExtend<Parameters<typeof runTool<typeof addItem>>[1]>();
  // Matched on `execute` alone: a bare object with one is a tool too.
  const bare = { execute: (args: { n: number }) => args.n * 2 };
  expectTypeOf(await runTool(bare, { n: 2 })).toEqualTypeOf<number>();
  // The name form is unchanged.
  expectTypeOf(runTool({ tools: { add_item: addItem } }, "add_item", ctx)).resolves.toBeUnknown();
});

test("expectDeployable's config names only what the specs read — not the config schema", () => {
  expectTypeOf<DeployedConfig["mode"]>().toEqualTypeOf<"pipeline" | "s2s" | "text">();
  expectTypeOf<DeployedConfig["name"]>().toEqualTypeOf<string>();
  expectTypeOf<DeployedConfig["systemPrompt"]>().toEqualTypeOf<string>();
});
