import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("Solo RPG", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Solo RPG");
  });

  test("enables run_code builtin tool", () => {
    expect(agent.builtinTools).toContain("run_code");
  });

  test("has rpg tools", () => {
    expect(Object.keys(agent.tools!)).toEqual(
      expect.arrayContaining([
        "check_state",
        "setup_character",
        "action_roll",
        "burn_momentum",
        "oracle",
        "update_state",
      ]),
    );
  });

  test("check_state returns initial game state", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("show me my character", [{ tool: "check_state", args: {} }]);
    expect(turn).toHaveCalledTool("check_state");
    const state = turn.toolResult("check_state");
    expect(state.initialized).toBe(false);
    expect(state.phase).toBe("genre");
  });

  test("oracle generates random results", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("ask the oracle", [{ tool: "oracle", args: { type: "yes_no" } }]);
    expect(turn).toHaveCalledTool("oracle", { type: "yes_no" });
    const result = turn.toolResult("oracle");
    expect(result).toHaveProperty("type", "yes_no");
  });

  test("update_state can change location", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("move to the tavern", [
      {
        tool: "update_state",
        args: { location: "The Silver Tankard", locationDesc: "A warm tavern" },
      },
    ]);
    expect(turn).toHaveCalledTool("update_state");
    expect(turn.toolResults[0]).toBeDefined();
  });
});
