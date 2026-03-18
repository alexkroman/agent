// Copyright 2025 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runNewCommand } from "./new.tsx";

describe("runNewCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("--help prints help and returns", async () => {
    const result = await runNewCommand(["--help"], "1.0.0");
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0]?.[0];
    expect(output).toContain("init");
    expect(output).toContain("--template");
    expect(result).toBe("");
  });
});
