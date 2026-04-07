import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("Dr. Sage (Health Assistant)", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Dr. Sage");
  });

  test("enables web_search and run_code builtin tools", () => {
    expect(agent.builtinTools).toContain("web_search");
    expect(agent.builtinTools).toContain("run_code");
  });

  test("has medication_lookup and check_drug_interaction tools", () => {
    expect(agent.tools).toHaveProperty("medication_lookup");
    expect(agent.tools).toHaveProperty("check_drug_interaction");
  });

  test("BMI calculation via run_code", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Calculate BMI for 70kg and 1.75m", [
      {
        tool: "run_code",
        args: { code: "const bmi = 70 / (1.75 * 1.75); console.log(bmi.toFixed(1))" },
      },
    ]);
    expect(turn).toHaveCalledTool("run_code");
    expect(turn.toolResults[0]).toBe("22.9");
  });
});
