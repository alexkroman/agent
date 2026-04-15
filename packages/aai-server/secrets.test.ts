// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import {
  _clearHashCache,
  decryptEnv,
  deriveCredentialKey,
  encryptEnv,
  hashApiKey,
  timingSafeCompare,
  verifySlugOwner,
} from "./secrets.ts";
import { createTestStore } from "./test-utils.ts";

afterEach(() => {
  _clearHashCache();
});

describe("hashApiKey", () => {
  test("produces a 64-char hex string (SHA-256)", async () => {
    const hash = await hashApiKey("test-key");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same input produces same hash", async () => {
    const a = await hashApiKey("key-1");
    const b = await hashApiKey("key-1");
    expect(a).toBe(b);
  });

  test("different inputs produce different hashes", async () => {
    const a = await hashApiKey("key-1");
    const b = await hashApiKey("key-2");
    expect(a).not.toBe(b);
  });
});

describe("_clearHashCache", () => {
  test("clears cache in test environment", async () => {
    const hash1 = await hashApiKey("cache-key");
    _clearHashCache();
    const hash2 = await hashApiKey("cache-key");
    expect(hash1).toBe(hash2);
  });

  test("is a no-op in production", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await hashApiKey("prod-key");
      _clearHashCache();
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

describe("timingSafeCompare", () => {
  test("returns true for identical strings", () => {
    expect(timingSafeCompare("abc", "abc")).toBe(true);
  });

  test("returns false for different strings of same length", () => {
    expect(timingSafeCompare("abc", "xyz")).toBe(false);
  });

  test("returns false for different-length strings", () => {
    expect(timingSafeCompare("short", "longer-string")).toBe(false);
  });

  test("handles empty strings", () => {
    expect(timingSafeCompare("", "")).toBe(true);
  });

  test("returns false when one is empty", () => {
    expect(timingSafeCompare("", "a")).toBe(false);
  });
});

describe("verifySlugOwner", () => {
  test("returns 'unclaimed' when slug has no manifest", async () => {
    const store = createTestStore();
    const result = await verifySlugOwner("my-api-key", {
      slug: "nonexistent",
      store,
    });
    expect(result.status).toBe("unclaimed");
    expect(result).toHaveProperty("keyHash");
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
        allowedHosts: [],
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
        allowedHosts: [],
      },
    });
    const result = await verifySlugOwner("intruder-key", {
      slug: "my-agent",
      store,
    });
    expect(result.status).toBe("forbidden");
  });
});

describe("credential encryption", () => {
  const testEnv = { API_KEY: "sk-123", DB_URL: "postgres://localhost" };

  test("encrypt then decrypt returns original env", async () => {
    const key = await deriveCredentialKey("master-secret");
    const encrypted = await encryptEnv(key, {
      env: testEnv,
      slug: "my-agent",
    });
    const decrypted = await decryptEnv(key, {
      encrypted,
      slug: "my-agent",
    });
    expect(decrypted).toEqual(testEnv);
  });

  test("encrypted output is a base64url string with IV prepended", async () => {
    const key = await deriveCredentialKey("master-secret");
    const encrypted = await encryptEnv(key, {
      env: testEnv,
      slug: "my-agent",
    });
    expect(encrypted).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("different slugs cannot decrypt each other (AAD mismatch)", async () => {
    const key = await deriveCredentialKey("master-secret");
    const encrypted = await encryptEnv(key, {
      env: testEnv,
      slug: "agent-a",
    });
    await expect(decryptEnv(key, { encrypted, slug: "agent-b" })).rejects.toThrow();
  });

  test("different keys cannot decrypt", async () => {
    const key1 = await deriveCredentialKey("secret-1");
    const key2 = await deriveCredentialKey("secret-2");
    const encrypted = await encryptEnv(key1, {
      env: testEnv,
      slug: "my-agent",
    });
    await expect(decryptEnv(key2, { encrypted, slug: "my-agent" })).rejects.toThrow();
  });

  test("deriveCredentialKey is deterministic for same secret", async () => {
    const key1 = await deriveCredentialKey("same-secret");
    const key2 = await deriveCredentialKey("same-secret");
    const encrypted = await encryptEnv(key1, {
      env: { x: "1" },
      slug: "s",
    });
    const decrypted = await decryptEnv(key2, { encrypted, slug: "s" });
    expect(decrypted).toEqual({ x: "1" });
  });
});
