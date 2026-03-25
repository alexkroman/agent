import { describe, expect, test } from "vitest";
import { createTestHarness } from "@alexkroman1/aai/testing";
import agent from "./agent.ts";

describe("Memory Agent", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Memory Agent");
  });

  test("enables web_search and memory builtin tools", () => {
    expect(agent.builtinTools).toContain("web_search");
    expect(agent.builtinTools).toContain("memory");
  });

  test("harness can be created", () => {
    const t = createTestHarness(agent);
    expect(t).toBeDefined();
  });
});
