import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { AgentDef, Kv, ToolDef } from "../index.ts";
import { agent, tool } from "../index.ts";
import { DEFAULT_GREETING, DEFAULT_SYSTEM_PROMPT } from "./types.ts";

describe("constants", () => {
  test("DEFAULT_SYSTEM_PROMPT is a non-empty string", () => {
    expect(typeof DEFAULT_SYSTEM_PROMPT).toBe("string");
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test("DEFAULT_GREETING is a non-empty string", () => {
    expect(typeof DEFAULT_GREETING).toBe("string");
    expect(DEFAULT_GREETING.length).toBeGreaterThan(0);
  });
});

describe("type contracts", () => {
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
    const t = tool({ description: "no params", execute: () => "ok" });
    expectTypeOf(t).toMatchTypeOf<ToolDef>();
  });

  test("agent() accepts tools record", () => {
    const t = tool({
      description: "echo",
      parameters: z.object({ msg: z.string() }),
      execute: ({ msg }) => msg,
    });
    const def = agent({ name: "with-tools", tools: { echo: t } });
    expectTypeOf(def).toEqualTypeOf<AgentDef>();
  });

  test("Kv.get returns Promise<unknown> by default", () => {
    expectTypeOf<Kv["get"]>().returns.toEqualTypeOf<Promise<unknown>>();
  });

  test("Kv.set accepts various value types", () => {
    expectTypeOf<Kv["set"]>().toBeCallableWith("key", "string-value");
    expectTypeOf<Kv["set"]>().toBeCallableWith("key", 42);
    expectTypeOf<Kv["set"]>().toBeCallableWith("key", { nested: true });
    expectTypeOf<Kv["set"]>().returns.toEqualTypeOf<Promise<void>>();
  });

  test("Kv.delete accepts string or string[]", () => {
    expectTypeOf<Kv["delete"]>().toBeCallableWith("single-key");
    expectTypeOf<Kv["delete"]>().toBeCallableWith(["key1", "key2"]);
    expectTypeOf<Kv["delete"]>().returns.toEqualTypeOf<Promise<void>>();
  });
});
