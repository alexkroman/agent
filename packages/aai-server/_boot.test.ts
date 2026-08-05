// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { isLocalDev, requireEnv, resolvePort } from "./_boot.ts";

// ── isLocalDev ─────────────────────────────────────────────────────────

describe("isLocalDev", () => {
  test("true when AAI_LOCAL_DEV=1", () => {
    expect(isLocalDev({ AAI_LOCAL_DEV: "1", SUPABASE_STORAGE_BUCKET: "blobs" })).toBe(true);
  });

  test("true when SUPABASE_STORAGE_BUCKET is unset", () => {
    expect(isLocalDev({})).toBe(true);
  });

  test("false when SUPABASE_STORAGE_BUCKET is set and AAI_LOCAL_DEV is not 1", () => {
    expect(isLocalDev({ SUPABASE_STORAGE_BUCKET: "aai-blobs" })).toBe(false);
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

// ── resolvePort ────────────────────────────────────────────────────────

describe("resolvePort", () => {
  test.each([
    ["unset", undefined, 8080],
    ["empty string", "", 8080],
    ["explicit value", "3000", 3000],
  ] as const)("%s → %s", (_label, raw, expected) => {
    expect(resolvePort(raw, 8080)).toBe(expected);
  });

  test("throws on an unparseable PORT instead of binding an ephemeral one", () => {
    // listen(NaN) binds an ephemeral port: the process looks healthy while
    // the platform proxy's configured port gets nothing. Fail boot instead.
    for (const raw of ["tcp://0.0.0.0:8080", "abc", "-1", "70000", "80.5"]) {
      expect(() => resolvePort(raw, 8080)).toThrow("Invalid PORT");
    }
  });
});
