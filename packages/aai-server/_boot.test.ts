// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { isLocalDev, requireEnv, resolveDrainMs, resolvePort } from "./_boot.ts";
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
    // Unlike a disable-on-zero knob, 0 is a meaningful setting here: it restores the
    // old close-immediately shutdown. Substituting the two-minute default
    // would make a deploy look hung for whoever set it.
    expect(resolveDrainMs("0")).toBe(0);
  });
});
