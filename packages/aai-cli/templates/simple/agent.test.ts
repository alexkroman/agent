import { describe, expect, test } from "vitest";
import { createTestHarness } from "@alexkroman1/aai/testing";
import agent from "./agent.ts";

describe("Simple Assistant", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Simple Assistant");
  });

  test("harness can be created", () => {
    const t = createTestHarness(agent);
    expect(t).toBeDefined();
    expect(t.messages).toHaveLength(0);
  });

  test("conversation tracks messages", async () => {
    const t = createTestHarness(agent);
    await t.turn("Hello");
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]!.content).toBe("Hello");
  });
});
