// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import type { AgentState } from "./types.ts";
import { MIC_BUFFER_SECONDS } from "./types.ts";

describe("types", () => {
  test("MIC_BUFFER_SECONDS equals 0.1", () => {
    expect(MIC_BUFFER_SECONDS).toBe(0.1);
  });

  test("AgentState type covers all expected states", () => {
    const states: AgentState[] = [
      "disconnected",
      "connecting",
      "ready",
      "listening",
      "thinking",
      "speaking",
      "error",
    ];
    for (const s of states) {
      expect(typeof s).toBe("string");
    }
    expect(states).toHaveLength(7);
  });
});
