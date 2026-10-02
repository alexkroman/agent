import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { AgentDef, ToolDef } from "../index.ts";
import { agent, tool } from "../index.ts";
import { withTools } from "./tool-registry.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./types.ts";

describe("constants", () => {
  test("DEFAULT_SYSTEM_PROMPT is a non-empty string", () => {
    expect(typeof DEFAULT_SYSTEM_PROMPT).toBe("string");
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});

describe("type contracts", () => {
  test("agent() returns AgentDef, with the mode it declared known", () => {
    const def = agent({ name: "test" });
    expectTypeOf(def).toExtend<AgentDef>();
    expectTypeOf(def.mode).toEqualTypeOf<"pipeline">();
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
    expectTypeOf(t).toExtend<ToolDef<typeof params>>();
  });

  test("tool() works without parameters", () => {
    const t = tool({ description: "no params", execute: () => "ok" });
    expectTypeOf(t).toExtend<ToolDef>();
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
    expectTypeOf(def).toExtend<AgentDef>();
    expect(def.tools.echo).toBe(t);
  });
});
