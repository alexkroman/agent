// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { assertServiceRoleKey, isLocalDev, requireEnv, resolvePort } from "./_boot.ts";

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

// ── assertServiceRoleKey ───────────────────────────────────────────────

/** A legacy Supabase key: an unsigned JWT carrying the given claims. */
function jwt(claims: Record<string, unknown>): string {
  return ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
}

describe("assertServiceRoleKey", () => {
  test.each([
    ["a new-style publishable key", "sb_publishable_AbCdEfGhIjKlMnOpQrStUv"],
    ["a legacy anon JWT", jwt({ role: "anon" })],
  ])("rejects %s", (_label, key) => {
    // Both consumers of this variable fail without naming the credential: a
    // Storage blob write dies on RLS, and Realtime's filtered subscribes retry
    // forever with nothing surfaced at all.
    expect(() => assertServiceRoleKey(key)).toThrow("PUBLISHABLE (anon) key");
  });

  test.each([
    ["a new-style secret key", "sb_secret_AbCdEfGhIjKlMnOpQrStUv"],
    ["a legacy service_role JWT", jwt({ role: "service_role" })],
  ])("accepts %s", (_label, key) => {
    expect(() => assertServiceRoleKey(key)).not.toThrow();
  });

  test("never echoes the key into the error", () => {
    const secret = "AbCdEfGhIjKlMnOpQrStUv";
    let message = "";
    try {
      assertServiceRoleKey(`sb_publishable_${secret}`);
    } catch (err) {
      message = (err as Error).message;
    }
    // Asserted on the captured message rather than through `toThrow`, which
    // takes only a string/regex/Error — an asymmetric matcher passed to it is
    // ignored, so `toThrow(expect.not.stringContaining(…))` asserts nothing
    // beyond "it threw".
    //
    // The message is destined for boot logs, so it names the SETTING and the
    // shape it wants, never the value it found.
    expect(message).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(message).not.toContain(secret);
  });

  test.each([
    ["an unrecognizable key", "some-opaque-token"],
    ["a JWT with no role claim", jwt({ sub: "x" })],
    ["a JWT with an undecodable payload", "header.!!!not-base64!!!.sig"],
    ["an empty string", ""],
  ])("passes %s through for Supabase to reject", (_label, key) => {
    // Same trade as assertSessionModeUrl: validating credentials in general is
    // not this function's job, and Supabase rejects an unusable one with a
    // better message than a shape check can produce.
    expect(() => assertServiceRoleKey(key)).not.toThrow();
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
