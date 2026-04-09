import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@alexkroman1/aai-cli/testing";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("Solo RPG", () => {
  test("check_state returns initial game state", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("show me my character", [{ tool: "check_state", args: {} }]);
    const state = turn.toolResult<{ initialized: boolean; phase: string }>("check_state");
    expect(state.initialized).toBe(false);
    expect(state.phase).toBe("genre");
  });

  test("oracle generates random results", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("ask the oracle", [{ tool: "oracle", args: { type: "yes_no" } }]);
    const result = turn.toolResult<{ type: string }>("oracle");
    expect(result).toHaveProperty("type", "yes_no");
  });

  test("update_state can change location", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("move to the tavern", [
      {
        tool: "update_state",
        args: { location: "The Silver Tankard", locationDesc: "A warm tavern" },
      },
    ]);
    const result = turn.toolResult("update_state");
    expect(result).toBeDefined();
  });
});
