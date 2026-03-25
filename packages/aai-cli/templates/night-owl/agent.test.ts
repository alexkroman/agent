import { describe, expect, test } from "vitest";
import { createTestHarness } from "@alexkroman1/aai/testing";
import agent from "./agent.ts";

describe("Night Owl", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Night Owl");
  });

  test("enables run_code builtin tool", () => {
    expect(agent.builtinTools).toContain("run_code");
  });

  test("has recommend tool", () => {
    expect(agent.tools).toHaveProperty("recommend");
  });

  test("recommend returns movie picks for a mood", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Recommend a cozy movie", [
      { tool: "recommend", args: { category: "movie", mood: "cozy" } },
    ]);
    expect(turn.toHaveCalledTool("recommend", { category: "movie", mood: "cozy" })).toBe(true);
    const result = JSON.parse(turn.toolResults[0]!);
    expect(result.picks).toHaveLength(3);
    expect(result.picks).toContain("Paddington 2");
  });

  test("recommend returns music picks", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Something chill to listen to", [
      { tool: "recommend", args: { category: "music", mood: "chill" } },
    ]);
    expect(turn.toHaveCalledTool("recommend", { category: "music" })).toBe(true);
    const result = JSON.parse(turn.toolResults[0]!);
    expect(result.picks.length).toBeGreaterThan(0);
  });

  test("recommend returns book picks", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("A spooky book", [
      { tool: "recommend", args: { category: "book", mood: "spooky" } },
    ]);
    const result = JSON.parse(turn.toolResults[0]!);
    expect(result.category).toBe("book");
    expect(result.mood).toBe("spooky");
  });
});
