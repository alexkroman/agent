import { describe, expect, test } from "vitest";
import { createTestHarness } from "@alexkroman1/aai/testing";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("AssemblyAI Support", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("AssemblyAI Support");
  });

  test("enables vector_search builtin tool", () => {
    expect(agent.builtinTools).toContain("vector_search");
  });

  test("harness can be created", () => {
    const t = createTestHarness(agent);
    expect(t).toBeDefined();
  });
});
