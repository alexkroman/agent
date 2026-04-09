// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { TurnResult } from "./testing.ts";

// Import matchers to extend expect
import "./matchers.ts";

function makeTurnResult(
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: unknown }>,
): TurnResult {
  return new TurnResult(toolCalls);
}

describe("toHaveCalledTool", () => {
  test("passes when tool was called", () => {
    const turn = makeTurnResult([{ name: "get_weather", args: { city: "NYC" }, result: "sunny" }]);
    expect(turn).toHaveCalledTool("get_weather");
  });

  test("fails when tool was NOT called", () => {
    const turn = makeTurnResult([{ name: "get_weather", args: { city: "NYC" }, result: "sunny" }]);
    expect(turn).not.toHaveCalledTool("search_flights");
  });

  test("passes with matching partial args", () => {
    const turn = makeTurnResult([
      {
        name: "add_pizza",
        args: { size: "large", crust: "thin", toppings: ["pepperoni"] },
        result: "added",
      },
    ]);
    expect(turn).toHaveCalledTool("add_pizza", { size: "large" });
  });

  test("fails with wrong args", () => {
    const turn = makeTurnResult([{ name: "add_pizza", args: { size: "small" }, result: "added" }]);
    expect(turn).not.toHaveCalledTool("add_pizza", { size: "large" });
  });

  test("fails gracefully for non-TurnResult value", () => {
    expect(() => {
      expect("not a turn result").toHaveCalledTool("anything");
    }).toThrow(/expected a TurnResult/);
  });

  test(".not.toHaveCalledTool on a tool that WAS called", () => {
    const turn = makeTurnResult([{ name: "search", args: {}, result: "results" }]);
    expect(() => {
      expect(turn).not.toHaveCalledTool("search");
    }).toThrow(/expected turn NOT to have called tool "search"/);
  });

  test("message includes called tool names for debugging", () => {
    const turn = makeTurnResult([
      { name: "tool_a", args: {}, result: "" },
      { name: "tool_b", args: {}, result: "" },
    ]);
    expect(() => {
      expect(turn).toHaveCalledTool("tool_c");
    }).toThrow(/tool_a.*tool_b/);
  });

  test("works with empty tool calls list", () => {
    const turn = makeTurnResult([]);
    expect(turn).not.toHaveCalledTool("anything");
  });
});
