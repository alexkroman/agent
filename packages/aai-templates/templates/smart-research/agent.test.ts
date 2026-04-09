import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDirTestHarness } from "@alexkroman1/aai/testing-v2";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("Smart Research Agent", () => {
  test("harness loads with research tools", async () => {
    const t = await createDirTestHarness(join(__dirname));
    expect(t).toBeDefined();
  });

  test("save_source tracks URLs", async () => {
    const t = await createDirTestHarness(join(__dirname));
    const turn = await t.turn("Found a good source", [
      { tool: "save_source", args: { url: "https://example.com", title: "Example" } },
    ]);
    const result = turn.toolResult<{ saved: boolean; totalSources: number }>("save_source");
    expect(result.saved).toBe(true);
    expect(result.totalSources).toBe(1);
  });

  test("advance_phase moves through research phases", async () => {
    const t = await createDirTestHarness(join(__dirname));

    const turn1 = await t.turn("Move to analysis", [{ tool: "advance_phase", args: {} }]);
    const result1 = turn1.toolResult<{ phase: string }>("advance_phase");
    expect(result1.phase).toBe("analyze");

    const turn2 = await t.turn("Ready to respond", [{ tool: "advance_phase", args: {} }]);
    const result2 = turn2.toolResult<{ phase: string }>("advance_phase");
    expect(result2.phase).toBe("respond");
  });

  test("conversation_summary counts messages", async () => {
    const t = await createDirTestHarness(join(__dirname));

    // Turn adds a user message to ctx.messages
    const turn = await t.turn("Summarize the conversation", [
      { tool: "conversation_summary", args: {} },
    ]);
    const result = turn.toolResult<{ totalMessages: number }>("conversation_summary");
    expect(result.totalMessages).toBeGreaterThanOrEqual(1);
  });
});
