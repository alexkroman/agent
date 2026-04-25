// Copyright 2025 the AAI authors. MIT license.
import { beforeEach, describe, expect, test } from "vitest";
import {
  _clearVerifyCache,
  decryptEnv,
  encryptEnv,
  hashApiKey,
  importMasterKey,
  verifyApiKeyHash,
  verifySlugOwner,
} from "./secrets.ts";
import { createTestStore } from "./test-utils.ts";

beforeEach(() => {
  _clearVerifyCache();
});

describe("hashApiKey", () => {
  test("produces pbkdf2 format string", async () => {
    const hash = await hashApiKey("test-key");
    expect(hash).toMatch(/^pbkdf2:600000:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
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

    // Cold PBKDF2 takes ~100ms; warm cache hit should be far faster.
    expect(warm).toBeLessThan(cold / 5);
  });

  test("negative results are cached (wrong key stays wrong)", async () => {
    const hash = await hashApiKey("right-key");
    expect(await verifyApiKeyHash("wrong-key", hash)).toBe(false);
    const start = performance.now();
    expect(await verifyApiKeyHash("wrong-key", hash)).toBe(false);
    expect(performance.now() - start).toBeLessThan(20);
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
    if (result.status === "unclaimed") {
      expect(result.keyHash).toMatch(/^pbkdf2:/);
    }
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
    const masterKey = await importMasterKey("master-secret");
    const encrypted = await encryptEnv(masterKey, {
      env: testEnv,
      slug: "my-agent",
    });
    const decrypted = await decryptEnv(masterKey, {
      encrypted,
      slug: "my-agent",
    });
    expect(decrypted).toEqual(testEnv);
  });

  test("encrypted output is base64url with version byte 0x01", async () => {
    const masterKey = await importMasterKey("master-secret");
    const encrypted = await encryptEnv(masterKey, {
      env: testEnv,
      slug: "my-agent",
    });
    expect(encrypted).toMatch(/^[A-Za-z0-9_-]+$/);
    const { fromBase64Url } = await import("./base64url.ts");
    const raw = fromBase64Url(encrypted);
    expect(raw[0]).toBe(0x01);
  });

  test("same input produces different ciphertexts (unique salt + IV)", async () => {
    const masterKey = await importMasterKey("master-secret");
    const a = await encryptEnv(masterKey, { env: testEnv, slug: "s" });
    const b = await encryptEnv(masterKey, { env: testEnv, slug: "s" });
    expect(a).not.toBe(b);
  });

  test("different slugs cannot decrypt each other", async () => {
    const masterKey = await importMasterKey("master-secret");
    const encrypted = await encryptEnv(masterKey, {
      env: testEnv,
      slug: "agent-a",
    });
    await expect(decryptEnv(masterKey, { encrypted, slug: "agent-b" })).rejects.toThrow();
  });

  test("different master keys cannot decrypt", async () => {
    const key1 = await importMasterKey("secret-1");
    const key2 = await importMasterKey("secret-2");
    const encrypted = await encryptEnv(key1, {
      env: testEnv,
      slug: "my-agent",
    });
    await expect(decryptEnv(key2, { encrypted, slug: "my-agent" })).rejects.toThrow();
  });

  test("importMasterKey is deterministic — same secret can decrypt", async () => {
    const key1 = await importMasterKey("same-secret");
    const key2 = await importMasterKey("same-secret");
    const encrypted = await encryptEnv(key1, {
      env: { x: "1" },
      slug: "s",
    });
    const decrypted = await decryptEnv(key2, { encrypted, slug: "s" });
    expect(decrypted).toEqual({ x: "1" });
  });

  test("empty env round-trips", async () => {
    const masterKey = await importMasterKey("test-secret");
    const encrypted = await encryptEnv(masterKey, { env: {}, slug: "s" });
    expect(await decryptEnv(masterKey, { encrypted, slug: "s" })).toEqual({});
  });

  test("unrecognized version byte throws", async () => {
    const masterKey = await importMasterKey("test-secret");
    const encrypted = await encryptEnv(masterKey, {
      env: testEnv,
      slug: "s",
    });
    const { fromBase64Url, toBase64Url } = await import("./base64url.ts");
    const raw = fromBase64Url(encrypted);
    raw[0] = 0xff;
    const corrupted = toBase64Url(raw);
    await expect(decryptEnv(masterKey, { encrypted: corrupted, slug: "s" })).rejects.toThrow(
      "Unknown env encryption version: 255",
    );
  });
});

describe("env size limit", () => {
  test("throws when serialized env exceeds MAX_ENV_SIZE", async () => {
    const masterKey = await importMasterKey("test-secret");
    const largeValue = "x".repeat(70_000);
    await expect(encryptEnv(masterKey, { env: { BIG: largeValue }, slug: "s" })).rejects.toThrow(
      /exceeds maximum/,
    );
  });

  test("allows env just under the limit", async () => {
    const masterKey = await importMasterKey("test-secret");
    // JSON overhead: {"K":"..."} = 8 bytes, so value can be up to 65536 - 8
    const value = "x".repeat(65_528);
    const encrypted = await encryptEnv(masterKey, {
      env: { K: value },
      slug: "s",
    });
    const decrypted = await decryptEnv(masterKey, { encrypted, slug: "s" });
    expect(decrypted.K).toBe(value);
  });
});
