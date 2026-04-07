import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("AssemblyAI Support", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("AssemblyAI Support");
  });

  test("harness can be created", () => {
    const t = createTestHarness(agent);
    expect(t).toBeDefined();
  });
});
