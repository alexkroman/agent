// Copyright 2026 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { envCount, envMs, resolveHarnessPath } from "./constants.ts";

describe("envMs", () => {
  test.each([
    [undefined, 500],
    ["", 500],
    ["   ", 500],
    ["10m", 500],
    ["-1", 500],
    ["Infinity", 500],
  ])("falls back for %j", (raw, expected) => {
    expect(envMs(raw, 500)).toBe(expected);
  });

  test("honours an explicit zero, which `|| default` would swallow", () => {
    expect(envMs("0", 500)).toBe(0);
    expect(envMs("1500", 500)).toBe(1500);
    expect(envMs("2.5", 500)).toBe(2.5);
  });
});

describe("envCount", () => {
  test("accepts positive integers only", () => {
    expect(envCount("3", 2)).toBe(3);
    expect(envCount("1", 2)).toBe(1);
  });

  test.each([undefined, "", "0", "-2", "1.5", "two"])("falls back for %j", (raw) => {
    expect(envCount(raw, 2)).toBe(2);
  });
});

describe("resolveHarnessPath", () => {
  test("an explicit GUEST_HARNESS_PATH wins", () => {
    expect(resolveHarnessPath({ GUEST_HARNESS_PATH: "/opt/harness.mjs" })).toBe("/opt/harness.mjs");
  });

  test("otherwise resolves the aai-guest build, which this suite's globalSetup ensures", () => {
    const resolved = resolveHarnessPath({});
    expect(resolved).toMatch(/harness\.mjs$/);
    expect(existsSync(resolved)).toBe(true);
  });
});
