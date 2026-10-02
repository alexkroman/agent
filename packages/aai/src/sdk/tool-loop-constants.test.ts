// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { agent } from "./define.ts";
import { DEFAULT_MAX_STEPS, DEFAULT_TOOL_CHOICE } from "./tool-loop-constants.ts";

describe("tool-loop defaults", () => {
  test("cap tool steps at a positive whole number, with the model choosing tools", () => {
    expect(Number.isInteger(DEFAULT_MAX_STEPS)).toBe(true);
    expect(DEFAULT_MAX_STEPS).toBeGreaterThan(0);
    expect(DEFAULT_TOOL_CHOICE).toBe("auto");
  });

  test("are what agent() fills in when the author names neither", () => {
    expect(agent({ name: "t" }).maxSteps).toBe(DEFAULT_MAX_STEPS);
  });
});
