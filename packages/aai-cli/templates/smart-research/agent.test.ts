import { describe, expect, test } from "vitest";
import { createTestHarness } from "@alexkroman1/aai/testing";
import agent from "./agent.ts";

describe("Smart Research Agent", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Smart Research Agent");
  });

  test("enables web_search builtin tool", () => {
    expect(agent.builtinTools).toContain("web_search");
  });

  test("has research-phase tools", () => {
    expect(agent.tools).toHaveProperty("save_source");
    expect(agent.tools).toHaveProperty("mark_complex");
    expect(agent.tools).toHaveProperty("advance_phase");
    expect(agent.tools).toHaveProperty("analyze");
    expect(agent.tools).toHaveProperty("conversation_summary");
  });

  test("save_source tracks URLs", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Found a good source", [
      { tool: "save_source", args: { url: "https://example.com", title: "Example" } },
    ]);
    expect(turn.toHaveCalledTool("save_source")).toBe(true);
    const result = JSON.parse(turn.toolResults[0]!);
    expect(result.saved).toBe(true);
    expect(result.totalSources).toBe(1);
  });

  test("advance_phase moves through research phases", async () => {
    const t = createTestHarness(agent);

    const turn1 = await t.turn("Move to analysis", [
      { tool: "advance_phase", args: {} },
    ]);
    const result1 = JSON.parse(turn1.toolResults[0]!);
    expect(result1.phase).toBe("analyze");

    const turn2 = await t.turn("Ready to respond", [
      { tool: "advance_phase", args: {} },
    ]);
    const result2 = JSON.parse(turn2.toolResults[0]!);
    expect(result2.phase).toBe("respond");
  });

  test("conversation_summary counts messages", async () => {
    const t = createTestHarness(agent);
    t.addUserMessage("Hello");
    t.addAssistantMessage("Hi there");

    const turn = await t.turn("Summarize the conversation", [
      { tool: "conversation_summary", args: {} },
    ]);
    const result = JSON.parse(turn.toolResults[0]!);
    expect(result.totalMessages).toBeGreaterThanOrEqual(3);
  });
});
