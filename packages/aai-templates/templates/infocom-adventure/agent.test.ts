import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("Infocom Adventure", () => {
  test("game_state_get returns initial state", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("look around", [{ tool: "game_state_get", args: {} }]);
    const state = turn.toolResult<{ inventory: string[]; score: number; moves: number }>(
      "game_state_get",
    );
    expect(state.inventory).toEqual([]);
    expect(state.score).toBe(0);
    expect(state.moves).toBe(0);
  });

  test("take and drop items", async () => {
    const t = await createTestHarness(join(__dirname));

    const takeTurn = await t.turn("take the lantern", [
      { tool: "game_state_take", args: { value: "brass lantern" } },
    ]);
    const takeResult = takeTurn.toolResult<{ inventory: string[] }>("game_state_take");
    expect(takeResult.inventory).toContain("brass lantern");

    const dropTurn = await t.turn("drop the lantern", [
      { tool: "game_state_drop", args: { value: "brass lantern" } },
    ]);
    const dropResult = dropTurn.toolResult<{ inventory: string[] }>("game_state_drop");
    expect(dropResult.inventory).not.toContain("brass lantern");
  });

  test("move to a new room", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("go north", [
      { tool: "game_state_move", args: { value: "kitchen" } },
    ]);
    const result = turn.toolResult<{ currentRoom: string; moves: number }>("game_state_move");
    expect(result.currentRoom).toBe("kitchen");
    expect(result.moves).toBe(1);
  });

  test("score points", async () => {
    const t = await createTestHarness(join(__dirname));
    const turn = await t.turn("solve puzzle", [{ tool: "game_state_score", args: { value: 10 } }]);
    const result = turn.toolResult<{ score: number }>("game_state_score");
    expect(result.score).toBe(10);
  });
});
