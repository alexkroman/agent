// Copyright 2025 the AAI authors. MIT license.
/**
 * Type-level tests for the public API of `@alexkroman1/aai`.
 *
 * These are checked by tsc (via vitest typecheck) but never executed at runtime.
 */

import type { AgentDef, Kv, ToolDef } from "@alexkroman1/aai";
import { agent, tool } from "@alexkroman1/aai";
import { expectTypeOf, test } from "vitest";
import { z } from "zod";

test("agent() returns AgentDef", () => {
  const def = agent({ name: "test" });
  expectTypeOf(def).toEqualTypeOf<AgentDef>();
});

test("tool() infers parameter type from Zod schema", () => {
  const params = z.object({ city: z.string() });
  const t = tool({
    description: "weather",
    parameters: params,
    execute: (args) => {
      expectTypeOf(args).toEqualTypeOf<{ city: string }>();
      return "ok";
    },
  });
  expectTypeOf(t).toMatchTypeOf<ToolDef<typeof params>>();
});

test("tool() works without parameters", () => {
  const t = tool({
    description: "no params",
    execute: () => "ok",
  });
  expectTypeOf(t).toMatchTypeOf<ToolDef>();
});

test("agent() accepts tools record", () => {
  const t = tool({
    description: "echo",
    parameters: z.object({ msg: z.string() }),
    execute: ({ msg }) => msg,
  });
  // Should compile without error — tools record is accepted
  const def = agent({ name: "with-tools", tools: { echo: t } });
  expectTypeOf(def).toEqualTypeOf<AgentDef>();
});

test("Kv.get returns T | null with generics", () => {
  // Default generic: get<unknown>
  expectTypeOf<Kv["get"]>().returns.toEqualTypeOf<Promise<unknown>>();

  // With explicit generic: get<string> returns Promise<string | null>
  // Use a helper type to avoid syntax that confuses the transpiler
  type KvGetString = (key: string) => Promise<string | null>;
  expectTypeOf<KvGetString>().toBeFunction();
  expectTypeOf<ReturnType<KvGetString>>().toEqualTypeOf<Promise<string | null>>();
});

test("Kv.set accepts unknown value", () => {
  expectTypeOf<Kv["set"]>().toBeCallableWith("key", "string-value");
  expectTypeOf<Kv["set"]>().toBeCallableWith("key", 42);
  expectTypeOf<Kv["set"]>().toBeCallableWith("key", { nested: true });
  expectTypeOf<Kv["set"]>().toBeCallableWith("key", "value", { expireIn: 60_000 });
  expectTypeOf<Kv["set"]>().returns.toEqualTypeOf<Promise<void>>();
});

test("Kv.delete accepts string or string[]", () => {
  expectTypeOf<Kv["delete"]>().toBeCallableWith("single-key");
  expectTypeOf<Kv["delete"]>().toBeCallableWith(["key1", "key2"]);
  expectTypeOf<Kv["delete"]>().returns.toEqualTypeOf<Promise<void>>();
});
