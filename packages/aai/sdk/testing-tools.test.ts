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

  test("a no-argument tool may pass the context in the arguments' place", async () => {
    // The 66 `, {}, ` call sites this exists to delete: a tool that takes
    // nothing had to pass an empty object between the two values a reader cares
    // about.
    const ctx = createToolContext({ sessionId: "session-b" });
    expect(await runTool(agentDef, "add_item", ctx)).toEqual({
      added: undefined,
      session: "session-b",
    });
  });

  test("the context passed in the arguments' place is the SAME session, not a copy", async () => {
    // The property the shorthand would be worthless without: two calls sharing a
    // context share slots, which is what a stateful tool's spec is about.
    const ctx = createToolContext({ sessionId: "session-c" });
    const first = (await runTool(agentDef, "add_item", { item: "apple" }, ctx)) as {
      session: string;
    };
    const second = (await runTool(agentDef, "add_item", ctx)) as { session: string };
    expect(second.session).toBe(first.session);
  });

  test("with neither argument, the tool runs against a fresh distinct session", async () => {
    // A default context is a DISTINCT session with empty slots — right for a
    // stateless tool, and never what two calls sharing state want.
    type Added = { added: unknown; session: string };
    const first = (await runTool(agentDef, "add_item")) as Added;
    const second = (await runTool(agentDef, "add_item")) as Added;
    expect(first.session).not.toBe(second.session);
    expect(first.added).toBeUndefined();
  });

  test("an arguments object is never mistaken for a context", async () => {
    // The probe is three fields and one of them is a FUNCTION, which JSON from a
    // model cannot carry. A bag that merely LOOKS session-shaped is still args.
    const echo = { tools: { echo: { description: "e", execute: (args: unknown) => args } } };
    const lookalike = { sessionId: "not-a-context", slots: {}, send: "nope" };
    expect(await runTool(echo, "echo", lookalike)).toEqual(lookalike);
  });
});
