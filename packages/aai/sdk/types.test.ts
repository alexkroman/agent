import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { AgentDef, Db, ToolDef } from "../index.ts";
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

  test("tool() infers input type from Zod schema", () => {
    const params = z.object({ city: z.string() });
    const t = tool({
      description: "weather",
      inputSchema: params,
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
      inputSchema: z.object({ msg: z.string() }),
      execute: ({ msg }) => msg,
    });
    const def = agent({ name: "with-tools", tools: { echo: t } });
    expectTypeOf(def).toEqualTypeOf<AgentDef>();
  });

  test("Db.query returns Promise<Record<string, unknown>[]> by default", () => {
    const query: Db["query"] = () => Promise.resolve([]);
    expectTypeOf(query("select 1")).toEqualTypeOf<Promise<Record<string, unknown>[]>>();
  });

  test("Db.query accepts sql alone or with params, and a row type argument", () => {
    expectTypeOf<Db["query"]>().toBeCallableWith("select 1");
    expectTypeOf<Db["query"]>().toBeCallableWith("select * from t where id = $1", [42]);
    const query: Db["query"] = () => Promise.resolve([]);
    expectTypeOf(query<{ id: number }>("select id from t")).toEqualTypeOf<
      Promise<{ id: number }[]>
    >();
  });
});
