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
    // requests for nonexistent slugs don't burn ~100ms of PBKDF2.
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

  test("encrypted output is base64url with version byte 0x02 (iron)", async () => {
    const masterKey = await importMasterKey("master-secret");
    const encrypted = await encryptEnv(masterKey, {
      env: testEnv,
      slug: "my-agent",
    });
    expect(encrypted).toMatch(/^[A-Za-z0-9_-]+$/);
    const { fromBase64Url } = await import("./base64url.ts");
    const raw = fromBase64Url(encrypted);
    expect(raw[0]).toBe(0x02);
    // The payload after the version byte is an iron protocol string.
    expect(new TextDecoder().decode(raw.slice(1))).toMatch(/^Fe26\.2\*/);
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

describe("legacy stored-format compatibility", () => {
  // ── Static fixtures ──────────────────────────────────────────────────────
  // Generated by running the pre-argon2/pre-iron production code (PBKDF2
  // hashing, v1 HKDF + AES-256-GCM envelope) — the formats production data
  // is stored in. If either of these tests fails, deployed tenants with
  // old records are locked out. Never regenerate these with new code.
  const LEGACY_PBKDF2_HASH =
    "pbkdf2:600000:ZSP_eaGhRah43WBZtvWTTA:kwjfBUzU_4m3b9mGWxyQRt1FovJvx0siQPtb8lJphB8";
  const LEGACY_V1_BLOB =
    "AX_kYpuOH_q-5pHW_47d0IakaS2h2ybg0F_JxShcvzxYP--WOMHtoPqXv0fiULYguqvFqeEo0a1ch90sBJ4qtCFovFPfaq9TT4WEN_jrTtchbVPhGFlWs8ISYtIlqh_0mH28FYdejt23k5G6";

  test("stored pbkdf2 hash still verifies with the right key", async () => {
    expect(await verifyApiKeyHash("fixture-api-key", LEGACY_PBKDF2_HASH)).toBe(true);
  });

  test("stored pbkdf2 hash rejects the wrong key", async () => {
    expect(await verifyApiKeyHash("wrong-key", LEGACY_PBKDF2_HASH)).toBe(false);
  });

  test("stored v1 env blob still decrypts", async () => {
    const masterKey = await importMasterKey("fixture-master-secret");
    const decrypted = await decryptEnv(masterKey, {
      encrypted: LEGACY_V1_BLOB,
      slug: "fixture-agent",
    });
    expect(decrypted).toEqual({
      API_KEY: "sk-fixture-123",
      DB_URL: "postgres://localhost/db",
    });
  });

  test("stored v1 env blob still enforces the slug binding (AAD)", async () => {
    const masterKey = await importMasterKey("fixture-master-secret");
    await expect(
      decryptEnv(masterKey, { encrypted: LEGACY_V1_BLOB, slug: "other-agent" }),
    ).rejects.toThrow();
  });

  // ── Dynamic legacy writers ───────────────────────────────────────────────
  // Reimplementations of the removed legacy *write* paths, used to prove the
  // kept read paths accept arbitrary legacy records (not just the pinned
  // fixtures above).

  async function legacyPbkdf2Hash(apiKey: string): Promise<string> {
    const iterations = 600_000;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(apiKey),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const derived = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      keyMaterial,
      256,
    );
    const { toBase64Url } = await import("./base64url.ts");
    return `pbkdf2:${iterations}:${toBase64Url(salt)}:${toBase64Url(new Uint8Array(derived))}`;
  }

  async function legacyEncryptEnv(
    secret: string,
    env: Record<string, string>,
    slug: string,
  ): Promise<string> {
    const enc = new TextEncoder();
    const masterKey = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
      "deriveKey",
    ]);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(slug) },
      masterKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(slug) },
      key,
      enc.encode(JSON.stringify(env)),
    );
    const out = new Uint8Array(1 + salt.byteLength + iv.byteLength + ciphertext.byteLength);
    out[0] = 0x01;
    out.set(salt, 1);
    out.set(iv, 1 + salt.byteLength);
    out.set(new Uint8Array(ciphertext), 1 + salt.byteLength + iv.byteLength);
    const { toBase64Url } = await import("./base64url.ts");
    return toBase64Url(out);
  }

  test("freshly written legacy pbkdf2 hash verifies via the public API", async () => {
    const stored = await legacyPbkdf2Hash("some-old-key");
    expect(await verifyApiKeyHash("some-old-key", stored)).toBe(true);
    expect(await verifyApiKeyHash("not-that-key", stored)).toBe(false);
  });

  test("freshly written v1 blob decrypts via the public API", async () => {
    const env = { TOKEN: "t-1", REGION: "eu" };
    const encrypted = await legacyEncryptEnv("roll-secret", env, "old-agent");
    const masterKey = await importMasterKey("roll-secret");
    expect(await decryptEnv(masterKey, { encrypted, slug: "old-agent" })).toEqual(env);
  });

  test("legacy and argon2 hashes coexist in one credential list", async () => {
    const store = createTestStore();
    const legacy = await legacyPbkdf2Hash("old-owner-key");
    const modern = await hashApiKey("new-owner-key");
    await store.putAgent({
      slug: "mixed-agent",
      env: {},
      worker: "code",
      clientFiles: {},
      credential_hashes: [legacy, modern],
      agentConfig: {
        name: "test",
        systemPrompt: "test",
        greeting: "",
        toolSchemas: [],
        allowedHosts: [],
      },
    });
    const oldOwner = await verifySlugOwner("old-owner-key", { slug: "mixed-agent", store });
    expect(oldOwner).toEqual({ status: "owned", keyHash: legacy });
    const newOwner = await verifySlugOwner("new-owner-key", { slug: "mixed-agent", store });
    expect(newOwner).toEqual({ status: "owned", keyHash: modern });
    const intruder = await verifySlugOwner("intruder", { slug: "mixed-agent", store });
    expect(intruder).toEqual({ status: "forbidden" });
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
