// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { hashApiKey, matchAnyHash, verifyApiKeyHash, verifySlugOwner } from "./secrets.ts";
import { createTestStore } from "./test-utils.ts";

describe("hashApiKey", () => {
  test("produces a self-describing sha256 digest", () => {
    expect(hashApiKey("test-key")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("is deterministic — no salt, no verify cache needed", () => {
    expect(hashApiKey("key-1")).toBe(hashApiKey("key-1"));
  });

  test("different inputs produce different digests", () => {
    expect(hashApiKey("key-1")).not.toBe(hashApiKey("key-2"));
  });
});

describe("verifyApiKeyHash", () => {
  test("returns true for correct key", () => {
    expect(verifyApiKeyHash("my-secret-key", hashApiKey("my-secret-key"))).toBe(true);
  });

  test("returns false for wrong key", () => {
    expect(verifyApiKeyHash("wrong-key", hashApiKey("my-secret-key"))).toBe(false);
  });

  test("returns false for malformed, empty, or foreign-format stored hashes", () => {
    expect(verifyApiKeyHash("key", "not-a-valid-hash")).toBe(false);
    expect(verifyApiKeyHash("key", "")).toBe(false);
    expect(verifyApiKeyHash("key", "bcrypt:10:abc:def")).toBe(false);
    // Pre-rewrite argon2 PHC strings never shipped, but must still read as
    // "no match" rather than an error.
    expect(verifyApiKeyHash("key", "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA")).toBe(false);
  });
});

describe("matchAnyHash", () => {
  test("returns the matching stored hash, or null", () => {
    const h1 = hashApiKey("key-1");
    const h2 = hashApiKey("key-2");
    expect(matchAnyHash("key-2", [h1, h2])).toBe(h2);
    expect(matchAnyHash("key-3", [h1, h2])).toBeNull();
    expect(matchAnyHash("key-1", [])).toBeNull();
  });
});

describe("verifySlugOwner", () => {
  test("returns 'unclaimed' when slug has no agent record", async () => {
    const store = createTestStore();
    const result = await verifySlugOwner("my-api-key", {
      slug: "nonexistent",
      store,
    });
    expect(result.status).toBe("unclaimed");
  });

  test("returns 'owned' when API key matches stored hash", async () => {
    const store = createTestStore();
    await store.putAgent({
      slug: "my-agent",
      env: {},
      worker: "code",
      clientFiles: {},
      credential_hashes: [hashApiKey("owner-key")],
    });
    const result = await verifySlugOwner("owner-key", {
      slug: "my-agent",
      store,
    });
    expect(result.status).toBe("owned");
  });

  test("returns 'forbidden' when API key does not match", async () => {
    const store = createTestStore();
    await store.putAgent({
      slug: "my-agent",
      env: {},
      worker: "code",
      clientFiles: {},
      credential_hashes: [hashApiKey("owner-key")],
    });
    const result = await verifySlugOwner("intruder-key", {
      slug: "my-agent",
      store,
    });
    expect(result.status).toBe("forbidden");
  });
});
