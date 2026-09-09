// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level contract of the `@alexkroman1/aai/testing` script positions — what
 * a spec may hand `generate`, and the one shape it may not.
 *
 * `{ text: "…" }` is the misuse this file exists for. A record without an
 * `object` key IS a route table, so that literal used to type-check as a table
 * with one route named `text` and then reject every call at run time; the
 * documentation page spent four lines teaching readers to remember the
 * discriminator. A claim about what does NOT compile belongs here, stated
 * positively, where it is counted by nothing — the same argument
 * `_session-slot-caps.test-d.ts` makes.
 */
import { expectTypeOf, test } from "vitest";
import type { ToolContextOverrides } from "./_testing-context.ts";
import type { StubGenerateScript } from "./testing-generate.ts";
import type { ScriptedToolContextOptions } from "./testing-scripted.ts";

/** The two legal single-reply shapes, and a route table. */
test("a script is a bare string, a `{ text, object }` reply, or a table of routes", () => {
  expectTypeOf<string>().toExtend<StubGenerateScript>();
  expectTypeOf<{ object: unknown }>().toExtend<StubGenerateScript>();
  expectTypeOf<{ text: string; object: unknown }>().toExtend<StubGenerateScript>();
  expectTypeOf<{ "You grade documents.": string }>().toExtend<StubGenerateScript>();
});

test("`{ text }` ALONE is not a script, in every position that takes one", () => {
  // The misuse arm on `StubGenerateRoutes` is what refuses it: the literal is
  // unassignable, and the message tsc prints is the rule.
  expectTypeOf<{ text: string }>().not.toExtend<StubGenerateScript>();
  expectTypeOf<{ generate: { text: string } }>().not.toExtend<ToolContextOverrides>();
  expectTypeOf<{ generate: { text: string } }>().not.toExtend<ScriptedToolContextOptions>();
});

test("the shapes a script position DOES take, so the arm above is not refusing everything", () => {
  // A negative assertion passes just as well against a type that admits
  // nothing, which is why each `not.toExtend` above needs its positive twin.
  expectTypeOf<{ generate: string }>().toExtend<ToolContextOverrides>();
  expectTypeOf<{ generate: { object: unknown } }>().toExtend<ToolContextOverrides>();
  expectTypeOf<{
    generate: { "You answer questions.": string };
  }>().toExtend<ToolContextOverrides>();
  expectTypeOf<{
    generate: { "You answer questions.": string };
  }>().toExtend<ScriptedToolContextOptions>();
});

test("a FUNCTION in the context's `generate` is the seam, and a route function is not", () => {
  // `createToolContext` cannot tell `GenerateFn` from `(call) => reply`, so the
  // field admits only the former; `scriptedToolContext` keeps the latter.
  expectTypeOf<{
    generate: () => Promise<{ text: string; object: unknown }>;
  }>().toExtend<ToolContextOverrides>();
  expectTypeOf<{ generate: () => string }>().not.toExtend<ToolContextOverrides>();
  expectTypeOf<{ generate: () => string }>().toExtend<ScriptedToolContextOptions>();
});
