// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { assertDevKeys, isLocalDev, requireEnv, resolveDrainMs, resolvePoolSize } from "./_boot.ts";
import { DEFAULT_SHUTDOWN_DRAIN_MS } from "./constants.ts";

// ── isLocalDev ─────────────────────────────────────────────────────────

describe("isLocalDev", () => {
  test("true when AAI_LOCAL_DEV=1", () => {
    expect(isLocalDev({ AAI_LOCAL_DEV: "1", SUPABASE_S3_ENDPOINT: "https://x" })).toBe(true);
  });

  test("true when SUPABASE_S3_ENDPOINT is unset", () => {
    expect(isLocalDev({})).toBe(true);
  });

  test("false when SUPABASE_S3_ENDPOINT is set and AAI_LOCAL_DEV is not 1", () => {
    expect(isLocalDev({ SUPABASE_S3_ENDPOINT: "https://ref.supabase.co/storage/v1/s3" })).toBe(
      false,
    );
  });
});

// ── requireEnv ─────────────────────────────────────────────────────────

describe("requireEnv", () => {
  test("returns the requested keys when all are present", () => {
    const env = { A: "1", B: "2", C: "ignored" };
    expect(requireEnv(env, ["A", "B"])).toEqual({ A: "1", B: "2" });
  });

  test("throws listing every missing key", () => {
    expect(() => requireEnv({ A: "1" }, ["A", "B", "C"])).toThrow(
      "Missing required environment variables: B, C",
    );
  });

  test("treats empty strings as missing", () => {
    expect(() => requireEnv({ A: "" }, ["A"])).toThrow("Missing required environment variables: A");
  });
});

// ── assertDevKeys ──────────────────────────────────────────────────────

const BOTH_KEYS = { ASSEMBLYAI_API_KEY: "aai", BRAVE_API_KEY: "brave" };

describe("assertDevKeys", () => {
  test("passes in dev when both keys are set", () => {
    expect(() => assertDevKeys({ ...BOTH_KEYS })).not.toThrow();
  });

  test.each([
    ["ASSEMBLYAI_API_KEY", { BRAVE_API_KEY: "brave" }],
    ["BRAVE_API_KEY", { ASSEMBLYAI_API_KEY: "aai" }],
  ] as const)("throws in dev naming the missing %s", (missing, env) => {
    expect(() => assertDevKeys(env)).toThrow(missing);
    expect(() => assertDevKeys(env)).toThrow("Set it in");
  });

  test("throws in dev naming both keys when both are missing", () => {
    expect(() => assertDevKeys({})).toThrow("ASSEMBLYAI_API_KEY and BRAVE_API_KEY");
    expect(() => assertDevKeys({})).toThrow("Set them in");
  });

  test("AAI_DEV_SKIP_KEY_CHECK=1 skips the check entirely", () => {
    expect(() => assertDevKeys({ AAI_DEV_SKIP_KEY_CHECK: "1" })).not.toThrow();
  });

  test("non-dev (SUPABASE_S3_ENDPOINT set) never throws", () => {
    expect(() =>
      assertDevKeys({ SUPABASE_S3_ENDPOINT: "https://ref.supabase.co/storage/v1/s3" }),
    ).not.toThrow();
  });
});

// ── resolvePoolSize ────────────────────────────────────────────────────

describe("resolvePoolSize", () => {
  test.each([
    ["unset", undefined, null],
    ["empty string", "", null],
    ["zero", "0", null],
    ["negative", "-1", null],
    ["non-numeric", "abc", null],
    ["in range", "4", 4],
    ["minimum", "1", 1],
    ["at the cap", "16", 16],
    ["over the cap clamps to 16", "99", 16],
  ] as const)("%s → %s", (_label, raw, expected) => {
    expect(resolvePoolSize(raw)).toBe(expected);
  });
});

// ── resolveDrainMs ─────────────────────────────────────────────────────

describe("resolveDrainMs", () => {
  test.each([
    ["unset", undefined, DEFAULT_SHUTDOWN_DRAIN_MS],
    ["empty string", "", DEFAULT_SHUTDOWN_DRAIN_MS],
    ["non-numeric", "abc", DEFAULT_SHUTDOWN_DRAIN_MS],
    ["negative", "-1", DEFAULT_SHUTDOWN_DRAIN_MS],
    ["explicit value", "30000", 30_000],
  ] as const)("%s → %s", (_label, raw, expected) => {
    expect(resolveDrainMs(raw)).toBe(expected);
  });

  test("zero means do not wait, not unset", () => {
    // Unlike resolvePoolSize, 0 is a meaningful setting here: it restores the
    // old close-immediately shutdown. Substituting the two-minute default
    // would make a deploy look hung for whoever set it.
    expect(resolveDrainMs("0")).toBe(0);
  });
});
