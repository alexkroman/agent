import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("FAQ Bot (Embedded Assets)", () => {
  test("list_topics returns available FAQ questions", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("What topics do you know about?", [
      { tool: "list_topics", args: {} },
    ]);
    const topics = turn.toolResult<string[]>("list_topics");
    expect(Array.isArray(topics)).toBe(true);
    expect(topics.length).toBeGreaterThan(0);
  });

  test("search_knowledge finds matching FAQ", async () => {
    const t = await createTestHarness(join(__dirname));
    // First find out what topics exist
    const listTurn = await t.turn("List topics", [{ tool: "list_topics", args: {} }]);
    const topics = listTurn.toolResult<string[]>("list_topics");
    const firstTopic = topics[0]!;

    // Search for it
    const searchTurn = await t.turn(`Tell me about ${firstTopic}`, [
      { tool: "search_knowledge", args: { query: firstTopic } },
    ]);
    const result = searchTurn.toolResult<{ question: string; answer: string }>("search_knowledge");
    expect(result).toHaveProperty("question");
    expect(result).toHaveProperty("answer");
  });

  test("search_knowledge returns no match for unknown query", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("xyznonexistent", [
      { tool: "search_knowledge", args: { query: "xyznonexistent123456" } },
    ]);
    const result = turn.toolResult<{ result: string }>("search_knowledge");
    expect(result.result).toBe("No matching FAQ found.");
  });
});
