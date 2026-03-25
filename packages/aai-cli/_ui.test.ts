// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  detail,
  errorLine,
  info,
  interactive,
  primary,
  runCommand,
  step,
  stepInfo,
  warn,
} from "./_ui.ts";

describe("color helpers", () => {
  test("primary wraps text", () => {
    const result = primary("hello");
    expect(result).toContain("hello");
    expect(typeof result).toBe("string");
  });

  test("interactive wraps text", () => {
    const result = interactive("world");
    expect(result).toContain("world");
    expect(typeof result).toBe("string");
  });

  test("primary handles empty string", () => {
    expect(typeof primary("")).toBe("string");
  });

  test("interactive handles empty string", () => {
    expect(typeof interactive("")).toBe("string");
  });
});

describe("message formatters", () => {
  test("step includes action and message", () => {
    const result = step("Build", "completed");
    expect(result).toContain("Build");
    expect(result).toContain("completed");
  });

  test("stepInfo includes action and message", () => {
    const result = stepInfo("Fetch", "data loaded");
    expect(result).toContain("Fetch");
    expect(result).toContain("data loaded");
  });

  test("info includes message", () => {
    expect(info("some details")).toContain("some details");
  });

  test("detail includes message", () => {
    expect(detail("detail text")).toContain("detail text");
  });

  test("warn includes message", () => {
    expect(warn("watch out")).toContain("watch out");
  });

  test("errorLine includes message", () => {
    expect(errorLine("something broke")).toContain("something broke");
  });
});

describe("runCommand", () => {
  test("logs steps and completes", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await runCommand(async ({ log }) => {
        log(step("Step1", "done"));
        log(step("Step2", "done"));
      });
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => l.includes("Step1"))).toBe(true);
    expect(logs.some((l) => l.includes("Step2"))).toBe(true);
  });

  test("propagates errors", async () => {
    await expect(
      runCommand(async () => {
        throw new Error("deploy failed");
      }),
    ).rejects.toThrow("deploy failed");
  });
});
