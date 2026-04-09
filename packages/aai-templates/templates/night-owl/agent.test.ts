import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("Night Owl", () => {
  test("recommend returns movie picks for a mood", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("Recommend a cozy movie", [
      { tool: "recommend", args: { category: "movie", mood: "cozy" } },
    ]);
    const result = turn.toolResult<{ picks: string[] }>("recommend");
    expect(result.picks).toHaveLength(3);
    expect(result.picks).toContain("Paddington 2");
  });

  test("recommend returns music picks", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("Something chill to listen to", [
      { tool: "recommend", args: { category: "music", mood: "chill" } },
    ]);
    const result = turn.toolResult<{ picks: string[] }>("recommend");
    expect(result.picks.length).toBeGreaterThan(0);
  });

  test("recommend returns book picks", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("A spooky book", [
      { tool: "recommend", args: { category: "book", mood: "spooky" } },
    ]);
    const result = turn.toolResult<{ category: string; mood: string }>("recommend");
    expect(result.category).toBe("book");
    expect(result.mood).toBe("spooky");
  });
});
