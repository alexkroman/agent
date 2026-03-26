import { describe, expect, test } from "vitest";
import { createTestHarness } from "@alexkroman1/aai/testing";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("Middleware Demo", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Middleware Demo");
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

  test("get_weather tool returns weather data", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("What's the weather in NYC?", [
      { tool: "get_weather", args: { city: "NYC" } },
    ]);
    expect(turn).toHaveCalledTool("get_weather", { city: "NYC" });
    const result = turn.toolResult<{ city: string; temperature: string; condition: string }>(
      "get_weather",
    );
    expect(result.city).toBe("NYC");
    expect(result.temperature).toBeDefined();
    expect(result.condition).toBe("partly cloudy");
  });

  test("calculate tool evaluates expressions", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Calculate 2+2", [
      { tool: "calculate", args: { expression: "2+2" } },
    ]);
    expect(turn).toHaveCalledTool("calculate");
    const result = turn.toolResult<{ expression: string; result: number }>("calculate");
    expect(result.expression).toBe("2+2");
    expect(result.result).toBe(4);
  });

  test("middleware array is configured", () => {
    expect(agent.middleware).toBeDefined();
    expect(agent.middleware!.length).toBe(4);
    expect(agent.middleware!.map((m) => m.name)).toEqual([
      "rate-limiter",
      "pii-redactor",
      "analytics-logger",
      "tool-call-cache",
    ]);
  });
});
