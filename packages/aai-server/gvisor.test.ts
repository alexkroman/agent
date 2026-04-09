// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, it } from "vitest";
import { isGvisorAvailable } from "./gvisor.ts";

describe("isGvisorAvailable", () => {
  it("returns a boolean", () => {
    const result = isGvisorAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("returns false on non-Linux platforms", () => {
    // On macOS (Darwin) and Windows, gVisor is never available
    if (process.platform !== "linux") {
      expect(isGvisorAvailable()).toBe(false);
    }
  });
});
