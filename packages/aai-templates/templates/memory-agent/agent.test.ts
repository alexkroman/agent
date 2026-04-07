import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("Memory Agent", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Memory Agent");
  });

  test("enables web_search builtin tool", () => {
    expect(agent.builtinTools).toContain("web_search");
  });
});
