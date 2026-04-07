import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("Math Buddy", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Math Buddy");
  });

  test("enables run_code builtin tool", () => {
    expect(agent.builtinTools).toContain("run_code");
  });

  test("harness can be created", () => {
    const t = createTestHarness(agent);
    expect(t).toBeDefined();
  });

  test("run_code can do calculations", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Calculate 15% tip on $85", [
      { tool: "run_code", args: { code: "console.log((85 * 0.15).toFixed(2))" } },
    ]);
    expect(turn).toHaveCalledTool("run_code");
    expect(turn.toolResults[0]).toBe("12.75");
  });
});
