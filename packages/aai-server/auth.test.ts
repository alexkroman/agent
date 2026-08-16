// Copyright 2025 the AAI authors. MIT license.
import { timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { hashApiKey, verifyApiKeyHash, verifySlugOwner } from "./secrets.ts";
import { createTestStore } from "./test-utils.ts";

// Everything except the compare primitive stays real. Wrapping
// `timingSafeEqual` is the only way to assert the constant-time claim without a
// wall-clock measurement, and the claim needs asserting: the suite that used to
// carry it checked digest FORMATTING, which a plain `===` satisfies.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

test("hashApiKey produces a deterministic sha256 digest", () => {
  const h = hashApiKey("key");
  expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(hashApiKey("key")).toBe(h);
  expect(verifyApiKeyHash("key", h)).toBe(true);
  // Different key does not verify
  expect(verifyApiKeyHash("other", h)).toBe(false);
});

test("verifySlugOwner returns unclaimed for missing slug", async () => {
  const store = createTestStore();
  const result = await verifySlugOwner("key1", { slug: "my-agent", store });
  // `toEqual` over the whole object: `expect("keyHash" in result).toBe(false)`
  // stood here, over a type whose only member is `status`, so it could never
  // fail. This says the same thing — no key material rides back out — in a form
  // that fails the day a field is added.
  expect(result).toEqual({ status: "unclaimed" });
});

test("verifySlugOwner returns owned for matching credential", async () => {
  const store = createTestStore();
  const hash = await hashApiKey("key1");
  await store.putAgent({
    slug: "my-agent",
    env: {},
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: [hash],
  });
  const result = await verifySlugOwner("key1", { slug: "my-agent", store });
  expect(result.status).toBe("owned");
});

test("verifySlugOwner returns forbidden for different credential", async () => {
  const store = createTestStore();
  const hash = await hashApiKey("key1");
  await store.putAgent({
    slug: "my-agent",
    env: {},
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: [hash],
  });
  const result = await verifySlugOwner("key2", { slug: "my-agent", store });
  expect(result.status).toBe("forbidden");
});

test("verifySlugOwner allows multiple credential hashes", async () => {
  const store = createTestStore();
  const hash1 = await hashApiKey("key1");
  const hash2 = await hashApiKey("key2");
  await store.putAgent({
    slug: "my-agent",
    env: {},
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: [hash1, hash2],
  });
  expect((await verifySlugOwner("key1", { slug: "my-agent", store })).status).toBe("owned");
  expect((await verifySlugOwner("key2", { slug: "my-agent", store })).status).toBe("owned");
  expect((await verifySlugOwner("key3", { slug: "my-agent", store })).status).toBe("forbidden");
});

test("verifySlugOwner rejects when credential_hashes is empty", async () => {
  const store = createTestStore();
  await store.putAgent({
    slug: "my-agent",
    env: {},
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: [],
  });
  expect((await verifySlugOwner("any-key", { slug: "my-agent", store })).status).toBe("forbidden");
});

describe("auth timing safety", () => {
  beforeEach(() => {
    // `restoreMocks` restores `vi.spyOn` mocks and does NOT clear a `vi.fn()`'s
    // call history, so without this an earlier test's call satisfies the next.
    vi.mocked(timingSafeEqual).mockClear();
  });

  test("verifyApiKeyHash compares through timingSafeEqual, not ===", () => {
    const stored = hashApiKey("key1");

    expect(verifyApiKeyHash("key1", stored)).toBe(true);
    expect(verifyApiKeyHash("key2", stored)).toBe(false);
    // One compare per call, both of them constant-time. An implementation that
    // short-circuits on `candidate === stored` passes every other assertion in
    // this file and fails here, which is the point of the suite.
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  test("a stored digest of the wrong length is false, never a throw", () => {
    // `timingSafeEqual` REJECTS unequal-length buffers with a RangeError, so
    // the length guard in front of it is load-bearing: a truncated or
    // corrupted stored digest has to be a `false`, not a 500 on every
    // owner-scoped route.
    expect(verifyApiKeyHash("key1", "sha256:deadbeef")).toBe(false);
    expect(verifyApiKeyHash("key1", "")).toBe(false);
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  test("digests are one fixed length whatever the key, which is what makes that work", () => {
    // The length guard above can only ever be an integrity check — never a
    // side channel on the key — because every digest is the same size.
    const shortKey = hashApiKey("a");
    const longKey = hashApiKey("a".repeat(1000));
    const emptyKey = hashApiKey("");

    const pattern = /^sha256:[0-9a-f]{64}$/;
    expect(shortKey).toMatch(pattern);
    expect(longKey).toMatch(pattern);
    expect(emptyKey).toMatch(pattern);
    expect(new Set([shortKey.length, longKey.length, emptyKey.length]).size).toBe(1);

    expect(verifyApiKeyHash("a", shortKey)).toBe(true);
    expect(verifyApiKeyHash("a".repeat(1000), longKey)).toBe(true);
    expect(verifyApiKeyHash("", emptyKey)).toBe(true);
  });
});
