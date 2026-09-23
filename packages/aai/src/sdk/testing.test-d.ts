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
import type { ToolContextOverrides } from "./_testing-context.ts";
import type { StubDelegateScript } from "./testing-delegate.ts";
import type { StubGenerateScript } from "./testing-generate.ts";
import type { ScriptedToolContextOptions } from "./testing-scripted.ts";
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
