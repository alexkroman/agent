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

describe("legacy stored-format compatibility", () => {
  // ── Static fixtures ──────────────────────────────────────────────────────
  // Generated by running the pre-argon2/pre-iron production code (PBKDF2
  // hashing, v1 HKDF + AES-256-GCM envelope) — the formats production data
  // is stored in. If either of these tests fails, deployed tenants with
  // old records are locked out. Never regenerate these with new code.
  const LEGACY_PBKDF2_HASH =
    "pbkdf2:600000:ZSP_eaGhRah43WBZtvWTTA:kwjfBUzU_4m3b9mGWxyQRt1FovJvx0siQPtb8lJphB8";
  test("stored pbkdf2 hash still verifies with the right key", async () => {
    expect(await verifyApiKeyHash("fixture-api-key", LEGACY_PBKDF2_HASH)).toBe(true);
  });

  test("stored pbkdf2 hash rejects the wrong key", async () => {
    expect(await verifyApiKeyHash("wrong-key", LEGACY_PBKDF2_HASH)).toBe(false);
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

  test("freshly written legacy pbkdf2 hash verifies via the public API", async () => {
    const stored = await legacyPbkdf2Hash("some-old-key");
    expect(await verifyApiKeyHash("some-old-key", stored)).toBe(true);
    expect(await verifyApiKeyHash("not-that-key", stored)).toBe(false);
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
