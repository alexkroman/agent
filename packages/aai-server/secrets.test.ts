// Copyright 2025 the AAI authors. MIT license.
import { beforeEach, describe, expect, test } from "vitest";
import { _clearVerifyCache, hashApiKey, verifyApiKeyHash, verifySlugOwner } from "./secrets.ts";
import { createTestStore } from "./test-utils.ts";

beforeEach(() => {
  _clearVerifyCache();
});

describe("hashApiKey", () => {
  test("produces argon2id PHC format string", async () => {
    const hash = await hashApiKey("test-key");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  });

  test("same input produces different hashes (unique salts)", async () => {
    const a = await hashApiKey("key-1");
    const b = await hashApiKey("key-1");
    expect(a).not.toBe(b);
  });

  test("different inputs produce different hashes", async () => {
    const a = await hashApiKey("key-1");
    const b = await hashApiKey("key-2");
    expect(a).not.toBe(b);
  });
});

describe("verifyApiKeyHash", () => {
  test("returns true for correct key", async () => {
    const hash = await hashApiKey("my-secret-key");
    expect(await verifyApiKeyHash("my-secret-key", hash)).toBe(true);
  });

  test("returns false for wrong key", async () => {
    const hash = await hashApiKey("my-secret-key");
    expect(await verifyApiKeyHash("wrong-key", hash)).toBe(false);
  });

  test("returns false for malformed stored hash", async () => {
    expect(await verifyApiKeyHash("key", "not-a-valid-hash")).toBe(false);
  });

  test("returns false for empty stored hash", async () => {
    expect(await verifyApiKeyHash("key", "")).toBe(false);
  });

  test("returns false for wrong algorithm prefix", async () => {
    expect(await verifyApiKeyHash("key", "bcrypt:10:abc:def")).toBe(false);
  });

  test("repeat verification is dramatically faster (cache hit)", async () => {
    const hash = await hashApiKey("my-secret-key");
    const start1 = performance.now();
    expect(await verifyApiKeyHash("my-secret-key", hash)).toBe(true);
    const cold = performance.now() - start1;

    const start2 = performance.now();
    expect(await verifyApiKeyHash("my-secret-key", hash)).toBe(true);
    const warm = performance.now() - start2;

    // Cold argon2 takes tens of ms; warm cache hit should be far faster.
    expect(warm).toBeLessThan(cold / 5);
  });

  test("negative results are cached (wrong key stays wrong)", async () => {
    const hash = await hashApiKey("right-key");
    expect(await verifyApiKeyHash("wrong-key", hash)).toBe(false);
    const start = performance.now();
    expect(await verifyApiKeyHash("wrong-key", hash)).toBe(false);
    expect(performance.now() - start).toBeLessThan(20);
  });

  test("distinct keys against the same stored hash cache independent results", async () => {
    // Guards the SHA-256(apiKey) cache keying: two keys verified against the
    // same stored hash must land in separate entries with distinct results.
    const hash = await hashApiKey("right-key");
    expect(await verifyApiKeyHash("right-key", hash)).toBe(true);
    expect(await verifyApiKeyHash("wrong-key", hash)).toBe(false);
    // Both answered from the cache now — and still distinct.
    expect(await verifyApiKeyHash("right-key", hash)).toBe(true);
    expect(await verifyApiKeyHash("wrong-key", hash)).toBe(false);
  });
});

describe("verifySlugOwner", () => {
  test("returns 'unclaimed' without a keyHash when slug has no manifest", async () => {
    const store = createTestStore();
    const result = await verifySlugOwner("my-api-key", {
      slug: "nonexistent",
      store,
    });
    expect(result.status).toBe("unclaimed");
    // Hashing is deferred to the deploy-claim path (middleware.ts) so
    // requests for nonexistent slugs don't burn an argon2 derivation.
    expect(result).not.toHaveProperty("keyHash");
  });

  test("returns 'owned' when API key matches stored hash", async () => {
    const store = createTestStore();
    const keyHash = await hashApiKey("owner-key");
    await store.putAgent({
      slug: "my-agent",
      env: {},
      worker: "code",
      clientFiles: {},
      credential_hashes: [keyHash],
      agentConfig: {
        name: "test",
        systemPrompt: "test",
        greeting: "",
        toolSchemas: [],
      },
    });
    const result = await verifySlugOwner("owner-key", {
      slug: "my-agent",
      store,
    });
    expect(result.status).toBe("owned");
  });

  test("returns 'forbidden' when API key does not match", async () => {
    const store = createTestStore();
    const ownerHash = await hashApiKey("owner-key");
    await store.putAgent({
      slug: "my-agent",
      env: {},
      worker: "code",
      clientFiles: {},
      credential_hashes: [ownerHash],
      agentConfig: {
        name: "test",
        systemPrompt: "test",
        greeting: "",
        toolSchemas: [],
      },
    });
    const result = await verifySlugOwner("intruder-key", {
      slug: "my-agent",
      store,
    });
    expect(result.status).toBe("forbidden");
  });
});
