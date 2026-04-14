import { describe, expect, it } from "vitest";
import { parseSandboxLimitsFromEnv } from "./sandbox-vm.ts";

describe("parseSandboxLimitsFromEnv", () => {
  it("returns defaults when no env vars set", () => {
    const limits = parseSandboxLimitsFromEnv({});
    expect(limits).toEqual({});
  });

  it("parses SANDBOX_MEMORY_LIMIT_MB", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "128" });
    expect(limits.memoryLimitBytes).toBe(134_217_728);
  });

  it("parses SANDBOX_PID_LIMIT", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_PID_LIMIT: "64" });
    expect(limits.pidLimit).toBe(64);
  });

  it("parses SANDBOX_TMPFS_LIMIT_MB", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_TMPFS_LIMIT_MB: "20" });
    expect(limits.tmpfsSizeBytes).toBe(20_971_520);
  });

  it("parses SANDBOX_CPU_TIME_LIMIT_SECS", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_CPU_TIME_LIMIT_SECS: "120" });
    expect(limits.cpuTimeLimitSecs).toBe(120);
  });

  it("clamps memory to valid range (16–512 MB)", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "8" }).memoryLimitBytes).toBe(
      16 * 1024 * 1024,
    );
    expect(parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "1024" }).memoryLimitBytes).toBe(
      512 * 1024 * 1024,
    );
  });

  it("clamps PIDs to valid range (8–256)", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_PID_LIMIT: "2" }).pidLimit).toBe(8);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_PID_LIMIT: "999" }).pidLimit).toBe(256);
  });

  it("ignores non-numeric values", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "abc" });
    expect(limits.memoryLimitBytes).toBeUndefined();
  });
});
