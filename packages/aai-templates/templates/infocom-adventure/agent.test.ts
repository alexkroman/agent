import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("Infocom Adventure", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Infocom Adventure");
  });

  test("has game state tools", () => {
    expect(Object.keys(agent.tools ?? {})).toEqual(
      expect.arrayContaining([
        "game_state_get",
        "game_state_move",
        "game_state_take",
        "game_state_drop",
        "game_state_score",
        "game_state_flag",
        "game_state_history",
      ]),
    );
  });

  test("game_state_get returns initial state", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("look around", [{ tool: "game_state_get", args: {} }]);
    expect(turn).toHaveCalledTool("game_state_get");
    const state = turn.toolResult("game_state_get");
    expect(state.inventory).toEqual([]);
    expect(state.score).toBe(0);
    expect(state.moves).toBe(0);
  });

  test("take and drop items", async () => {
    const t = createTestHarness(agent);

    const takeTurn = await t.turn("take the lantern", [
      { tool: "game_state_take", args: { value: "brass lantern" } },
    ]);
    const takeResult = takeTurn.toolResult("game_state_take");
    expect(takeResult.inventory).toContain("brass lantern");

    const dropTurn = await t.turn("drop the lantern", [
      { tool: "game_state_drop", args: { value: "brass lantern" } },
    ]);
    const dropResult = dropTurn.toolResult("game_state_drop");
    expect(dropResult.inventory).not.toContain("brass lantern");
  });

  test("move to a new room", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("go north", [
      { tool: "game_state_move", args: { value: "kitchen" } },
    ]);
    const result = turn.toolResult("game_state_move");
    expect(result.currentRoom).toBe("kitchen");
    expect(result.moves).toBe(1);
  });

  test("score points", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("solve puzzle", [{ tool: "game_state_score", args: { value: 10 } }]);
    const result = turn.toolResult("game_state_score");
    expect(result.score).toBe(10);
  });
});
