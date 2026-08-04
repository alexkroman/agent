// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the env-derived Modal sandbox limits and region pinning
 * (modal-sandbox-env.ts). Split from modal-sandbox.test.ts, which covers
 * the spawn flow and WarmHarness wiring.
 */

import { describe, expect, it } from "vitest";
import {
  assertModalResourcePairs,
  parseSandboxLimitsFromEnv,
  parseSandboxRegionsFromEnv,
} from "./modal-sandbox-env.ts";

describe("parseSandboxLimitsFromEnv", () => {
  it("returns empty object when no env vars are set", () => {
    expect(parseSandboxLimitsFromEnv({})).toEqual({});
  });

  // Caps are read with their reservation alongside, as production sets them;
  // these exercise the clamp, not the pairing (covered separately below).
  const withMemCap = (mb: string) =>
    parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_MB: "128", SANDBOX_MEMORY_LIMIT_MB: mb });
  const withCpuCap = (cores: string) =>
    parseSandboxLimitsFromEnv({ SANDBOX_CPU: "0.125", SANDBOX_CPU_LIMIT: cores });

  it("parses SANDBOX_MEMORY_LIMIT_MB", () => {
    expect(withMemCap("256").memoryLimitMiB).toBe(256);
  });

  it("clamps SANDBOX_MEMORY_LIMIT_MB to [128, 4096]", () => {
    expect(withMemCap("1").memoryLimitMiB).toBe(128);
    expect(withMemCap("99999").memoryLimitMiB).toBe(4096);
  });

  it("parses and clamps SANDBOX_CPU_LIMIT to [0.125, 16]", () => {
    expect(withCpuCap("2").cpuLimit).toBe(2);
    expect(withCpuCap("0.01").cpuLimit).toBe(0.125);
    expect(withCpuCap("64").cpuLimit).toBe(16);
  });

  it("clamps the reservation vars to the same bounds as their caps", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_MB: "1" }).memoryMiB).toBe(128);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_MB: "99999" }).memoryMiB).toBe(4096);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_CPU: "0.01" }).cpu).toBe(0.125);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_CPU: "64" }).cpu).toBe(16);
  });

  it("passes a bare cap through — pairing is Modal's rule, not the parser's", () => {
    // The subprocess backend honors memoryLimitMiB alone and has nothing to
    // reserve, so the parser stays backend-agnostic; assertModalResourcePairs
    // (below) is what rejects a bare cap, at the Modal spawn.
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "4096" });
    expect(limits).toEqual({ memoryLimitMiB: 4096 });
  });

  it("rejects a cap with no matching reservation, naming the env var to set", () => {
    // Modal fails creation on a bare cap either way; this names the variable.
    expect(() => assertModalResourcePairs({ memoryLimitMiB: 4096 })).toThrow(
      /SANDBOX_MEMORY_LIMIT_MB requires SANDBOX_MEMORY_MB/,
    );
    expect(() => assertModalResourcePairs({ cpuLimit: 4 })).toThrow(
      /SANDBOX_CPU_LIMIT requires SANDBOX_CPU/,
    );
    expect(() =>
      assertModalResourcePairs({ memoryMiB: 1024, memoryLimitMiB: 4096, cpu: 1, cpuLimit: 4 }),
    ).not.toThrow();
  });

  it("keeps a reservation below its cap — the burst range builds need", () => {
    // A guest idles as a voice session (~260 MB) and spikes to ~1.7 GB only
    // while rolldown bundles. Reserving the peak would bill every idle
    // sandbox for it; the cap is what has to clear the peak.
    const limits = parseSandboxLimitsFromEnv({
      SANDBOX_MEMORY_MB: "1024",
      SANDBOX_MEMORY_LIMIT_MB: "4096",
      SANDBOX_CPU: "1",
      SANDBOX_CPU_LIMIT: "4",
    });
    expect(limits).toMatchObject({ memoryMiB: 1024, memoryLimitMiB: 4096, cpu: 1, cpuLimit: 4 });
  });

  it("clamps a reservation that exceeds its cap (Modal rejects reservation > limit)", () => {
    const limits = parseSandboxLimitsFromEnv({
      SANDBOX_MEMORY_MB: "4096",
      SANDBOX_MEMORY_LIMIT_MB: "1024",
      SANDBOX_CPU: "8",
      SANDBOX_CPU_LIMIT: "2",
    });
    expect(limits).toMatchObject({ memoryMiB: 1024, memoryLimitMiB: 1024, cpu: 2, cpuLimit: 2 });
  });

  it("allows a bare reservation with no cap", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_MB: "512", SANDBOX_CPU: "2" });
    expect(limits).toEqual({ memoryMiB: 512, cpu: 2 });
  });

  it("parses SANDBOX_TIMEOUT_SECS into milliseconds, clamped to [300, 86400] secs", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_TIMEOUT_SECS: "3600" }).timeoutMs).toBe(3_600_000);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_TIMEOUT_SECS: "1" }).timeoutMs).toBe(300_000);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_TIMEOUT_SECS: "999999" }).timeoutMs).toBe(
      86_400_000,
    );
  });

  it("parses SANDBOX_IDLE_TIMEOUT_SECS into milliseconds, clamped to [60, 86400] secs", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_IDLE_TIMEOUT_SECS: "600" }).idleTimeoutMs).toBe(
      600_000,
    );
    expect(parseSandboxLimitsFromEnv({ SANDBOX_IDLE_TIMEOUT_SECS: "1" }).idleTimeoutMs).toBe(
      60_000,
    );
    expect(parseSandboxLimitsFromEnv({ SANDBOX_IDLE_TIMEOUT_SECS: "999999" }).idleTimeoutMs).toBe(
      86_400_000,
    );
  });

  it("ignores non-numeric and undefined values", () => {
    expect(
      parseSandboxLimitsFromEnv({
        SANDBOX_MEMORY_LIMIT_MB: "not-a-number",
        SANDBOX_CPU_LIMIT: undefined,
      }),
    ).toEqual({});
  });
});

// ── parseSandboxRegionsFromEnv ───────────────────────────────────────────────

describe("parseSandboxRegionsFromEnv", () => {
  it("returns undefined when MODAL_SANDBOX_REGION is unset or empty", () => {
    expect(parseSandboxRegionsFromEnv({})).toBeUndefined();
    expect(parseSandboxRegionsFromEnv({ MODAL_SANDBOX_REGION: "" })).toBeUndefined();
    expect(parseSandboxRegionsFromEnv({ MODAL_SANDBOX_REGION: " , " })).toBeUndefined();
  });

  it("parses a single region", () => {
    expect(parseSandboxRegionsFromEnv({ MODAL_SANDBOX_REGION: "us-east-1" })).toEqual([
      "us-east-1",
    ]);
  });

  it("parses a comma-separated list, trimming whitespace and dropping empties", () => {
    expect(
      parseSandboxRegionsFromEnv({ MODAL_SANDBOX_REGION: "us-east-1, us-east-2,,us-west-1 " }),
    ).toEqual(["us-east-1", "us-east-2", "us-west-1"]);
  });
});
