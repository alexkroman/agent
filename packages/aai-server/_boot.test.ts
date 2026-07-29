// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { assertDevKeys, isLocalDev, requireEnv, resolvePoolSize } from "./_boot.ts";

// ── isLocalDev ─────────────────────────────────────────────────────────

describe("isLocalDev", () => {
  test("true when AAI_LOCAL_DEV=1", () => {
    expect(isLocalDev({ AAI_LOCAL_DEV: "1", BUCKET_NAME: "b" })).toBe(true);
  });

  test("true when BUCKET_NAME is unset", () => {
    expect(isLocalDev({})).toBe(true);
  });

  test("false when BUCKET_NAME is set and AAI_LOCAL_DEV is not 1", () => {
    expect(isLocalDev({ BUCKET_NAME: "prod-bucket" })).toBe(false);
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

  test("non-dev (BUCKET_NAME set) never throws", () => {
    expect(() => assertDevKeys({ BUCKET_NAME: "prod-bucket" })).not.toThrow();
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
