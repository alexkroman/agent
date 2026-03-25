import { describe, expect, test } from "vitest";
import { createTestHarness } from "@alexkroman1/aai/testing";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("FAQ Bot (Embedded Assets)", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("FAQ Bot");
  });

  test("has search_knowledge and list_topics tools", () => {
    expect(agent.tools).toHaveProperty("search_knowledge");
    expect(agent.tools).toHaveProperty("list_topics");
  });

  test("list_topics returns available FAQ questions", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("What topics do you know about?", [
      { tool: "list_topics", args: {} },
    ]);
    expect(turn).toHaveCalledTool("list_topics");
    const topics = turn.toolResult("list_topics");
    expect(Array.isArray(topics)).toBe(true);
    expect(topics.length).toBeGreaterThan(0);
  });

  test("search_knowledge finds matching FAQ", async () => {
    const t = createTestHarness(agent);
    // First find out what topics exist
    const listTurn = await t.turn("List topics", [
      { tool: "list_topics", args: {} },
    ]);
    const topics = listTurn.toolResult<string[]>("list_topics");
    const firstTopic = topics[0]!;

    // Search for it
    const searchTurn = await t.turn(`Tell me about ${firstTopic}`, [
      { tool: "search_knowledge", args: { query: firstTopic } },
    ]);
    expect(searchTurn).toHaveCalledTool("search_knowledge");
    const result = searchTurn.toolResult("search_knowledge");
    expect(result).toHaveProperty("question");
    expect(result).toHaveProperty("answer");
  });

  test("search_knowledge returns no match for unknown query", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("xyznonexistent", [
      { tool: "search_knowledge", args: { query: "xyznonexistent123456" } },
    ]);
    const result = turn.toolResult("search_knowledge");
    expect(result.result).toBe("No matching FAQ found.");
  });
});
