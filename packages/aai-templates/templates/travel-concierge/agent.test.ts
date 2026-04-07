import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("Aria (Travel Concierge)", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Aria");
  });

  test("enables web_search, visit_webpage, and fetch_json", () => {
    expect(agent.builtinTools).toContain("web_search");
    expect(agent.builtinTools).toContain("visit_webpage");
    expect(agent.builtinTools).toContain("fetch_json");
  });

  test("harness can be created", () => {
    const t = createTestHarness(agent);
    expect(t).toBeDefined();
  });
});
