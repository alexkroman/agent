// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, it } from "vitest";
import { createToolContext } from "./_testing-context.ts";
import { subagent } from "./subagent.ts";
import { stubDelegate } from "./testing-delegate.ts";

const researcher = subagent({ name: "researcher", systemPrompt: "Research." });
const checker = subagent({ name: "fact-checker", systemPrompt: "Check." });

describe("subagent", () => {
  it("returns its definition unchanged", () => {
    const def = { name: "researcher", systemPrompt: "Research." };
    expect(subagent(def)).toBe(def);
  });
});

describe("stubDelegate", () => {
  it("answers a single route for every subagent", async () => {
    const desk = stubDelegate("Found it.");
    const result = await desk.delegate(researcher, { task: "look" });
    expect(result).toEqual({ text: "Found it.", steps: 1, toolCalls: [] });
    expect(await desk.delegate(checker, { task: "check" })).toMatchObject({ text: "Found it." });
  });

  it("routes by subagent name and records every call", async () => {
    const desk = stubDelegate({ researcher: "A finding.", "fact-checker": "It checks out." });

    expect((await desk.delegate(researcher, { task: "look" })).text).toBe("A finding.");
    expect((await desk.delegate(checker, { task: "verify", context: "be strict" })).text).toBe(
      "It checks out.",
    );

    expect(desk.calls.map((call) => call.subagent.name)).toEqual(["researcher", "fact-checker"]);
    expect(desk.calls.map((call) => call.task)).toEqual(["look", "verify"]);
    expect(desk.calls[1]?.options.context).toBe("be strict");
  });

  it("lets a route shift its own script", async () => {
    const queue = ["first", "second"];
    const desk = stubDelegate({ researcher: () => queue.shift() ?? "empty" });
    expect((await desk.delegate(researcher, { task: "a" })).text).toBe("first");
    expect((await desk.delegate(researcher, { task: "b" })).text).toBe("second");
    expect((await desk.delegate(researcher, { task: "c" })).text).toBe("empty");
  });

  it("fills a cost report from the tool calls a route declares", async () => {
    const desk = stubDelegate({
      researcher: { text: "Two lookups.", toolCalls: [{ name: "search", input: { q: "a" } }] },
    });
    const result = await desk.delegate(researcher, { task: "a" });
    // One more step than tool calls — the answering step. See `envelope`.
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toEqual([{ name: "search", input: { q: "a" } }]);
  });

  it("rejects an unrouted subagent, naming it and the routes there are", async () => {
    const desk = stubDelegate({ researcher: "A finding." });
    await expect(desk.delegate(checker, { task: "verify" })).rejects.toThrow(
      /no route for subagent "fact-checker".*Routed subagents: researcher/s,
    );
  });
});

describe("createToolContext", () => {
  it("defaults delegate to a rejection naming the helper to reach for", async () => {
    const ctx = createToolContext();
    await expect(ctx.delegate(researcher, { task: "look" })).rejects.toThrow(/stubDelegate/);
  });

  it("takes a stubbed delegate", async () => {
    const desk = stubDelegate("Found it.");
    const ctx = createToolContext({ delegate: desk.delegate });
    expect((await ctx.delegate(researcher, { task: "look" })).text).toBe("Found it.");
  });
});
