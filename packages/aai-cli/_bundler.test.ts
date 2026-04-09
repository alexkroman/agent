// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";

describe("buildAgentBundle", () => {
  test("module exports buildAgentBundle function", async () => {
    const mod = await import("./_bundler.ts");
    expect(typeof mod.buildAgentBundle).toBe("function");
  });

  test("module exports executeBuild function", async () => {
    const mod = await import("./_bundler.ts");
    expect(typeof mod.executeBuild).toBe("function");
  });
});
