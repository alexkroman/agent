import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("Penny (Personal Finance)", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Penny");
  });

  test("enables run_code and fetch_json builtin tools", () => {
    expect(agent.builtinTools).toContain("run_code");
    expect(agent.builtinTools).toContain("fetch_json");
  });
});
