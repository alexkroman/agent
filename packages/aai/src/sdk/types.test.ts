import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { AgentDef, ToolDef } from "../index.ts";
import { agent, tool } from "../index.ts";
// `Db` moved OFF the root when `ctx.db` went away — it is still the shape the
// runtime's own Postgres consumers take (upload records, session state, the
// world's postgres arm), so its contract still matters; it is just no longer an
// authoring type. See `sdk/db.ts`.
import type { Db } from "../internal.ts";
import { DEFAULT_GREETING } from "./agent-defaults.ts";
import { DEFAULT_BUILTIN_TOOLS } from "./constants.ts";
import { withTools } from "./tool-registry.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./types.ts";

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
  test("DEFAULT_BUILTIN_TOOLS carries listen_for, and nothing else", () => {
    // Every other builtin gives the agent something to DO, which is the
    // author's decision; `listen_for` changes only what it HEARS, and is worth
    // most exactly where nobody thought to switch it on. Anything else
    // arriving in this list is a product decision that has to be argued where
    // the constant is declared.
    expect(DEFAULT_BUILTIN_TOOLS).toEqual(["listen_for"]);
    // Still UNSET on the declaration: the default is applied when builtins are
    // resolved, so an agent's own config is unchanged by it and a config that
    // names nothing still round-trips as naming nothing.
    expect(agent({ name: "t" }).builtinTools).toBeUndefined();
  });

  test("naming any builtin REPLACES the default — the list is not a patch", () => {
    // The trap this pins: `["think"]` means think and nothing else, so an
    // author who wants to keep the recognizer hint has to name it too. Not
    // special-cased, because a tool that cannot be switched off is worse than
    // one that has to be re-named.
    expect(agent({ name: "t", builtinTools: ["think"] }).builtinTools).toEqual(["think"]);
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

  test("withTools puts a tool on the def agent() returns", () => {
    const t = tool({
      description: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: ({ msg }) => msg,
    });
    // `agent()` takes no tools — a tool is its file. This is the shape the build
    // produces, and it is still an ordinary `AgentDef` on the other side.
    const def = withTools(agent({ name: "with-tools" }), { echo: t });
    expectTypeOf(def).toEqualTypeOf<AgentDef>();
    expect(def.tools.echo).toBe(t);
  });

  test("Db.query returns Promise<Record<string, unknown>[]> by default", () => {
    // Still pinned, and deliberately: an INTERNAL type with three consumers across
    // two packages is exactly the kind whose signature drifts unnoticed.
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
