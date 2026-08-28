// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import {
  assertServiceRoleKey,
  hasPlatformDb,
  isLocalDev,
  PLATFORM_TIER_ENV,
  requireEnv,
  resolvePort,
} from "./_boot.ts";

// ── isLocalDev ─────────────────────────────────────────────────────────

describe("isLocalDev", () => {
  test("true only on an explicit AAI_LOCAL_DEV=1", () => {
    expect(isLocalDev({ AAI_LOCAL_DEV: "1" })).toBe(true);
    expect(isLocalDev({ AAI_LOCAL_DEV: "1", SUPABASE_STORAGE_BUCKET: "blobs" })).toBe(true);
  });

  // The whole point of the declaration: the DANGEROUS branch (an isolation-free
  // sandbox backend, an unverified bearer) must never be what a forgotten
  // variable selects. The old sentinel was `!SUPABASE_STORAGE_BUCKET`, i.e. the
  // exact inverse.
  test("false for an empty environment — the safe branch is the default", () => {
    expect(isLocalDev({})).toBe(false);
    expect(isLocalDev({ AAI_LOCAL_DEV: "0" })).toBe(false);
    expect(isLocalDev({ AAI_LOCAL_DEV: "true" })).toBe(false);
  });

  test("says nothing about where platform state lives", () => {
    // The two questions are independent: a dev server on the local Supabase
    // stack is local AND durable, which the single sentinel could not express.
    expect(isLocalDev({ AAI_LOCAL_DEV: "1", SUPABASE_DB_URL: "postgres://x" })).toBe(true);
    expect(hasPlatformDb({ AAI_LOCAL_DEV: "1", SUPABASE_DB_URL: "postgres://x" })).toBe(true);
  });
});

// ── hasPlatformDb ──────────────────────────────────────────────────────

describe("hasPlatformDb", () => {
  test("keys on SUPABASE_DB_URL alone", () => {
    expect(hasPlatformDb({ SUPABASE_DB_URL: "postgres://x" })).toBe(true);
    expect(hasPlatformDb({})).toBe(false);
    // Set-but-empty is not a connection string.
    expect(hasPlatformDb({ SUPABASE_DB_URL: "" })).toBe(false);
  });

  test("the storage bucket alone does not make a platform tier", () => {
    // It used to be the sentinel for everything, so a run with a bucket and no
    // database read as "production" and got memory stores anyway.
    expect(hasPlatformDb({ SUPABASE_STORAGE_BUCKET: "blobs" })).toBe(false);
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

  // listen(NaN) binds an ephemeral port: the process looks healthy while
  // the platform proxy's configured port gets nothing. Fail boot instead.
  test.each(["tcp://0.0.0.0:8080", "abc", "-1", "70000", "80.5"])(
    "throws on an unparseable PORT (%j) instead of binding an ephemeral one",
    (raw) => {
      expect(() => resolvePort(raw, 8080)).toThrow("Invalid PORT");
    },
  );
});

/**
 * What a platform tier requires, and why the list is worth a spec of its own.
 *
 * `AAI_PUBLIC_ORIGIN` was OPTIONAL until it became the only source of the base
 * URL a guest needs to reach the platform's workflow routes. Nothing failed when
 * that changed — a deployment without it kept booting and quietly ran every
 * durable workflow on the DevKit's local world, where the runs die with the
 * sandbox. This pins the requirement so the same silent downgrade cannot come
 * back by someone trimming the list.
 */
describe("PLATFORM_TIER_ENV", () => {
  test("names the three whose absence is silent", () => {
    // Spelled out rather than asserted by length: a member REMOVED here is a
    // silent-failure mode restored, so the diff has to show which.
    expect([...PLATFORM_TIER_ENV]).toEqual([
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "AAI_PUBLIC_ORIGIN",
    ]);
  });

  test("a platform tier missing the public origin is REFUSED, and the error names it", () => {
    // The case that motivated the list. Boot has to fail rather than fall back:
    // the fallback is durable runs that are not durable.
    expect(() =>
      requireEnv(
        { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" },
        PLATFORM_TIER_ENV,
      ),
    ).toThrow("AAI_PUBLIC_ORIGIN");
  });

  test("a fully configured platform tier passes", () => {
    // The positive control: without it the spec above would pass against a
    // `requireEnv` that rejected everything.
    expect(
      requireEnv(
        {
          SUPABASE_URL: "https://x.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "k",
          AAI_PUBLIC_ORIGIN: "https://aai.example",
        },
        PLATFORM_TIER_ENV,
      ).AAI_PUBLIC_ORIGIN,
    ).toBe("https://aai.example");
  });
});
