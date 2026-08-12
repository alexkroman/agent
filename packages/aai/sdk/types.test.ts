import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { AgentDef, Db, ToolDef } from "../index.ts";
import { agent, tool } from "../index.ts";
import { DEFAULT_BUILTIN_TOOLS } from "./constants.ts";
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

  /**
   * Pinned as an EQUALITY, not a containment.
   *
   * The only other assertion on this constant is
   * `expect.arrayContaining([...DEFAULT_BUILTIN_TOOLS])` in `runtime.test.ts`,
   * which is vacuously true for an empty array — so nothing checked the default
   * at all, and three separate docs (including the scaffold guide shipped to
   * users) went on describing a four-tool "cognitive set" default long after it
   * was removed. An agent that opts into no built-ins must get none.
   */
  test("DEFAULT_BUILTIN_TOOLS is empty — built-ins are opt-in by name", () => {
    expect(DEFAULT_BUILTIN_TOOLS).toEqual([]);
    expect(agent({ name: "t" }).builtinTools).toBeUndefined();
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
      input: params,
      run: (args) => {
        expectTypeOf(args).toEqualTypeOf<{ city: string }>();
        return "ok";
      },
    });
    expectTypeOf(t).toMatchTypeOf<ToolDef<typeof params>>();
  });

  test("tool() works without parameters", () => {
    const t = tool({ description: "no params", run: () => "ok" });
    expectTypeOf(t).toMatchTypeOf<ToolDef>();
  });

  test("agent() accepts tools record", () => {
    const t = tool({
      description: "echo",
      input: z.object({ msg: z.string() }),
      run: ({ msg }) => msg,
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
