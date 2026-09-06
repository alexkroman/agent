// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { subagent } from "./subagent.ts";
import { scriptedToolContext } from "./testing-scripted.ts";

const planner = subagent({ name: "planner", systemPrompt: "Plan." });

describe("scriptedToolContext", () => {
  test("wires both fakes into one context and hands them back", async () => {
    const { ctx, model, desk } = scriptedToolContext({
      generate: { "You triage.": { object: { response: "email" } } },
      delegate: { planner: "Three steps." },
    });
    expect(await ctx.generate({ system: "You triage.", prompt: "hi" })).toMatchObject({
      object: { response: "email" },
    });
    expect(await ctx.delegate(planner, { task: "plan it" })).toMatchObject({
      text: "Three steps.",
    });
    expect(model.calls.map((call) => call.system)).toEqual(["You triage."]);
    expect(desk.calls.map((call) => call.subagent.name)).toEqual(["planner"]);
  });

  test("an omitted script still builds the fake, which records and refuses", async () => {
    const { ctx, model, desk } = scriptedToolContext();
    await expect(ctx.generate({ prompt: "hi" })).rejects.toThrow(/no route/);
    await expect(ctx.delegate(planner, { task: "x" })).rejects.toThrow(/no route/);
    expect(model.calls).toHaveLength(1);
    expect(desk.calls).toHaveLength(1);
  });

  test("the other context fields pass through to createToolContext", () => {
    const { ctx } = scriptedToolContext({ sessionId: "s-1", env: { KEY: "v" } });
    expect(ctx.sessionId).toBe("s-1");
    expect(ctx.env).toEqual({ KEY: "v" });
    expect(ctx.sent).toEqual([]);
  });

  test("each call is a distinct session", () => {
    expect(scriptedToolContext().ctx.sessionId).not.toBe(scriptedToolContext().ctx.sessionId);
  });
});
