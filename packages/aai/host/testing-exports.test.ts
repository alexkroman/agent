import { describe, expect, it } from "vitest";
import { createTestHarness, toHaveCalledTool } from "./testing.ts";

describe("testing exports", () => {
  it("exports createTestHarness", () => {
    expect(typeof createTestHarness).toBe("function");
  });

  it("exports toHaveCalledTool from single entry point", () => {
    expect(typeof toHaveCalledTool).toBe("function");
  });
});
