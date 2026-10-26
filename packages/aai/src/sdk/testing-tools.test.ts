// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { tool } from "./define.ts";
import { createToolContext } from "./testing.ts";
import { runTool, toolOf, toolRunner } from "./testing-tools.ts";
import { toolset } from "./toolset.ts";
import type { ToolDef } from "./types.ts";
import { toolRefusal } from "./utils.ts";

// `tool()` rather than a bare `ToolDef` literal: the runs below are TYPED by
// the def, and the point of several cases is reading a field off the result.
const add = tool({
  description: "Add an item",
  inputSchema: z.object({ item: z.string().optional() }),
  execute: (args, ctx) => ({ added: args.item, session: ctx.sessionId }),
});

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

  test("says a tool def is not an agent, rather than dying on its missing map", () => {
    // The neighbouring mistake to the authored-def one below, and the natural
    // one when the tool under test was written inline: `toolOf(myTool, …)` used
    // to throw `Cannot read properties of undefined (reading 'add_item')` from
    // inside the SDK.
    const notAnAgent: unknown = add;
    expect(() => toolOf(notAnAgent as { tools: Record<string, ToolDef> }, "add_item")).toThrow(
      /takes the AGENT, not one tool/,
    );
  });

  test("names what it was handed when that is nothing at all", () => {
    const missing: unknown = undefined;
    expect(() => toolOf(missing as { tools: Record<string, ToolDef> }, "add_item")).toThrow(
      /was handed undefined rather than an agent definition/,
    );
  });

  test("says so when the agent declares none at all", () => {
    expect(() => toolOf({ tools: {} }, "anything")).toThrow("It declares: (none).");
  });
});

describe("runTool", () => {
  test("executes the tool against the context it is given", async () => {
    const ctx = createToolContext({ sessionId: "session-a" });
    expect(await runTool(add, { item: "apple" }, ctx)).toEqual({
      added: "apple",
      session: "session-a",
    });
  });

  test("awaits a synchronous result too, so a spec never has to know which it was", async () => {
    const ping = { description: "p", execute: () => "pong" };
    expect(await runTool(ping, createToolContext())).toBe("pong");
  });

  test("refuses a value with no `execute`, naming what it was handed", async () => {
    // The two things that used to land here: the agent (the old name form's
    // first argument) and the `undefined` a mistyped import answers with.
    // Reached the way an untyped caller reaches it — through `Reflect.apply`,
    // which the def-typed signature cannot refuse.
    await expect(Reflect.apply(runTool, undefined, [agentDef, {}])).rejects.toThrow(
      "runTool(tool, …) was handed a object with no `execute` rather than a tool",
    );
    await expect(Reflect.apply(runTool, undefined, [undefined])).rejects.toThrow(
      "was handed undefined rather than a tool",
    );
  });

  test("a no-argument tool may pass the context in the arguments' place", async () => {
    // The 66 `, {}, ` call sites this exists to delete: a tool that takes
    // nothing had to pass an empty object between the two values a reader cares
    // about.
    const ctx = createToolContext({ sessionId: "session-b" });
    expect(await runTool(add, ctx)).toEqual({ added: undefined, session: "session-b" });
  });

  test("the context passed in the arguments' place is the SAME session, not a copy", async () => {
    // The property the shorthand would be worthless without: two calls sharing a
    // context share slots, which is what a stateful tool's spec is about.
    const ctx = createToolContext({ sessionId: "session-c" });
    const first = await runTool(add, { item: "apple" }, ctx);
    const second = await runTool(add, ctx);
    expect(second.session).toBe(first.session);
  });

  test("with neither argument, the tool runs against a fresh distinct session", async () => {
    // A default context is a DISTINCT session with empty slots — right for a
    // stateless tool, and never what two calls sharing state want.
    const first = await runTool(add);
    const second = await runTool(add);
    expect(first.session).not.toBe(second.session);
    expect(first.added).toBeUndefined();
  });

  test("an arguments object is never mistaken for a context", async () => {
    // The probe is three fields and one of them is a FUNCTION, which JSON from a
    // model cannot carry. A bag that merely LOOKS session-shaped is still args.
    const echo = { description: "e", execute: (args: unknown) => args };
    const lookalike = { sessionId: "not-a-context", slots: {}, send: "nope" };
    expect(await runTool(echo, lookalike)).toEqual(lookalike);
  });

  test("is UNGATED: the def's own execute runs, whatever toolset the agent put it in", async () => {
    const gated: ToolDef = { description: "Gated", execute: () => "ran" };
    const refused = toolRefusal("roster", "not on the line");
    const def = { tools: {}, toolsets: [toolset("roster", { gated }, () => refused)] };
    expect(await runTool(gated, {})).toBe("ran");
    expect(await toolRunner(def)(gated, {})).toBe(refused);
  });
});

describe("toolRunner", () => {
  test("forwards both of runTool's shapes with the agent already bound", async () => {
    const run = toolRunner(agentDef);
    const ctx = createToolContext({ sessionId: "session-d" });

    expect(await run(add, { item: "apple" }, ctx)).toEqual({
      added: "apple",
      session: "session-d",
    });
    // The context in the arguments' place, for a tool that takes none.
    expect(await run(add, ctx)).toEqual({ added: undefined, session: "session-d" });
    expect(await run(add)).toMatchObject({ added: undefined });
  });

  test("each call still defaults to a distinct session, so the runner holds no state", async () => {
    // The runner is bound to the AGENT and nothing else. If it cached a context,
    // the two-context isolation test every stateful template writes would pass
    // for the wrong reason.
    const run = toolRunner(agentDef);
    const first = await run(add);
    const second = await run(add);
    expect(first.session).not.toBe(second.session);
  });

  test("refuses an agent with NO tools at BIND, naming the authored-def mistake", () => {
    // The bug the documentation page shipped for as long as it had fences: every
    // example bound a runner to `./agent.ts`'s default export, whose tool table
    // is empty because a tool is a FILE, so every `run(...)` on the page threw
    // "It declares: (none)" — a sentence about the call rather than about the
    // import that caused it. A runner over zero tools is always that mistake.
    expect(() => toolRunner({ tools: {} })).toThrow(/declares no tools, so every run/);
    expect(() => toolRunner({ tools: {} })).toThrow(/virtual:aai\/agent/);
  });

  test("leaves a non-agent to the first call, which knows the tool", async () => {
    // `toolOf` has a sentence for each way that happens, so binding cannot say
    // it. The runner is still returned, and the call names the shape.
    const missing: unknown = undefined;
    expect(() => toolRunner(missing as { tools: Record<string, ToolDef> })).not.toThrow();
    const broken = toolRunner as unknown as (agent: unknown) => ReturnType<typeof toolRunner>;
    await expect(broken({ tools: 1 })(add, {})).rejects.toThrow(
      "toolOf(agent, def) was handed a object with no `tools` rather than an agent definition",
    );
  });

  test("two runners over two agents stay bound to their own", async () => {
    const other: ToolDef = { description: "Other", execute: () => ({ from: "other" }) };
    const runOne = toolRunner(agentDef);
    const runTwo = toolRunner({ tools: { add_item: other } });
    expect(await runOne(add)).toMatchObject({ added: undefined });
    expect(await runTwo(other)).toEqual({ from: "other" });
  });

  test("resolves the def the agent registered by IDENTITY, not by shape", async () => {
    const run = toolRunner(agentDef);
    const ctx = createToolContext();
    expect(await run(add, { item: "apple" }, ctx)).toEqual({
      added: "apple",
      session: ctx.sessionId,
    });
    // A structural twin is a different tool, and the agent does not declare it.
    const twin: ToolDef = { ...add };
    await expect(run(twin, {})).rejects.toThrow("The agent declares no tool that IS this def");
  });

  test("goes through the toolset's GATE, exactly as the model's call does", async () => {
    const gated: ToolDef = { description: "Gated", execute: () => "ran" };
    const refused = toolRefusal("roster", "not on the line");
    const def = {
      tools: {},
      toolsets: [toolset("roster", { gated }, () => refused)],
    };
    expect(await toolRunner(def)(gated, {})).toBe(refused);
  });

  test("a def the agent does not declare throws naming the tools it does", async () => {
    const inline: ToolDef = { description: "Built inline", execute: () => "ok" };
    await expect(toolRunner(agentDef)(inline, {})).rejects.toThrow(
      'The agent declares no tool that IS this def (described as "Built inline"). It declares: add_item.',
    );
  });

  test("the miss over an EMPTY table carries the authored-def hint", async () => {
    // Reached through a runner bound before the table was checked (the agent
    // sentence above), or through `toolOf` directly — the hint is the same.
    expect(() => toolOf({ tools: {} }, "add_item")).toThrow(/virtual:aai\/agent/);
  });

  test("a value that is not a def is refused by shape, naming the two that are", async () => {
    const run = toolRunner(agentDef) as unknown as (target: unknown) => Promise<unknown>;
    await expect(run(undefined)).rejects.toThrow("was handed undefined rather than a tool def");
    await expect(run("add_item")).rejects.toThrow(
      "run(…) was handed a string with no `execute` rather than a tool def. Pass the tool " +
        "FILE's default export, or a speaker's `tools` entry",
    );
  });
});
