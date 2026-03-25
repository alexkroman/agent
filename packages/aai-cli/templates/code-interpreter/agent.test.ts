import { describe, expect, test } from "vitest";
import { createTestHarness } from "@alexkroman1/aai/testing";
import agent from "./agent.ts";

describe("Coda (Code Interpreter)", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Coda");
  });

  test("enables run_code builtin tool", () => {
    expect(agent.builtinTools).toContain("run_code");
  });

  test("harness can be created", () => {
    const t = createTestHarness(agent);
    expect(t).toBeDefined();
  });

  test("run_code executes JavaScript", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("What is 2 + 2?", [
      { tool: "run_code", args: { code: "console.log(2 + 2)" } },
    ]);
    expect(turn.toHaveCalledTool("run_code")).toBe(true);
    expect(turn.toolResults[0]).toBe("4");
  });
});
