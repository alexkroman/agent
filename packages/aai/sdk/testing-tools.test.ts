// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createToolContext } from "./testing.ts";
import { runTool, toolOf } from "./testing-tools.ts";
import type { ToolDef } from "./types.ts";

const add: ToolDef = {
  description: "Add an item",
  execute: (args, ctx) => ({ added: args.item, session: ctx.sessionId }),
};

const agentDef = { tools: { add_item: add } };

describe("toolOf", () => {
  test("returns the tool the agent declares under that name", () => {
    expect(toolOf(agentDef, "add_item")).toBe(add);
  });

  test("names the tools that DO exist, because a miss is nearly always a rename", () => {
    expect(() => toolOf(agentDef, "add_itme")).toThrow(
      "The agent declares no tool named add_itme. It declares: add_item.",
    );
  });

  test("says so when the agent declares none at all", () => {
    expect(() => toolOf({ tools: {} }, "anything")).toThrow("It declares: (none).");
  });
});

describe("runTool", () => {
  test("executes the tool against the context it is given", async () => {
    const ctx = createToolContext({ sessionId: "session-a" });
    expect(await runTool(agentDef, "add_item", { item: "apple" }, ctx)).toEqual({
      added: "apple",
      session: "session-a",
    });
  });

  test("awaits a synchronous result too, so a spec never has to know which it was", async () => {
    const sync = { tools: { ping: { description: "p", execute: () => "pong" } } };
    expect(await runTool(sync, "ping", {}, createToolContext())).toBe("pong");
  });

  test("propagates the lookup failure rather than returning it", async () => {
    await expect(runTool(agentDef, "missing", {}, createToolContext())).rejects.toThrow(
      "The agent declares no tool named missing",
    );
  });
});
