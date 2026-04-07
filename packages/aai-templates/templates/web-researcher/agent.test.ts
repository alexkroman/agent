import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("Scout (Web Researcher)", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Scout");
  });

  test("enables web_search and visit_webpage", () => {
    expect(agent.builtinTools).toContain("web_search");
    expect(agent.builtinTools).toContain("visit_webpage");
  });

  test("harness can be created", () => {
    const t = createTestHarness(agent);
    expect(t).toBeDefined();
  });

  test("conversation tracks messages across turns", async () => {
    const t = createTestHarness(agent);
    await t.turn("What is TypeScript?");
    t.addAssistantMessage("TypeScript is a typed superset of JavaScript.");
    await t.turn("Tell me more");
    expect(t.messages).toHaveLength(3);
  });
});
