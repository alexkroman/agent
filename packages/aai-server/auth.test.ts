// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { _clearHashCache, hashApiKey, verifySlugOwner } from "./secrets.ts";
import { createTestStore, TEST_AGENT_CONFIG } from "./test-utils.ts";

test("hashApiKey produces consistent 64-char hex", async () => {
  const h1 = await hashApiKey("key");
  const h2 = await hashApiKey("key");
  expect(h1).toBe(h2);
  expect(h1).toMatch(/^[0-9a-f]{64}$/);
  expect(await hashApiKey("other")).not.toBe(h1);
});

test("hashApiKey returns consistent result on repeated calls", async () => {
  _clearHashCache();
  const h1 = await hashApiKey("cached-key");
  const h2 = await hashApiKey("cached-key");
  expect(h2).toBe(h1);
  // Different key produces different hash
  const h3 = await hashApiKey("new-key");
  expect(h3).not.toBe(h1);
  _clearHashCache();
});

test("hashApiKey produces correct hashes after many calls", async () => {
  _clearHashCache();
  // Fill cache beyond capacity to verify eviction doesn't break correctness
  const hashes: string[] = [];
  for (let i = 0; i < 110; i++) {
    hashes.push(await hashApiKey(`evict-key-${i}`));
  }
  // Re-hashing the same keys should still produce the same results
  for (let i = 0; i < 110; i++) {
    expect(await hashApiKey(`evict-key-${i}`)).toBe(hashes[i]);
  }
  _clearHashCache();
});

test("verifySlugOwner returns unclaimed for missing slug", async () => {
  const store = createTestStore();
  const result = await verifySlugOwner("key1", { slug: "my-agent", store });
  expect(result.status).toBe("unclaimed");
  expect("keyHash" in result).toBe(true);
  expect((result as { keyHash: string }).keyHash).toBe(await hashApiKey("key1"));
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
    agentConfig: TEST_AGENT_CONFIG,
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
    agentConfig: TEST_AGENT_CONFIG,
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
    agentConfig: TEST_AGENT_CONFIG,
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
    agentConfig: TEST_AGENT_CONFIG,
  });
  expect((await verifySlugOwner("any-key", { slug: "my-agent", store })).status).toBe("forbidden");
});

// ── Auth Timing Safety ─────────────────────────────────────────────────

import { describe } from "vitest";

describe("auth timing safety", () => {
  test("API key hashes are always 64 hex chars (constant length)", async () => {
    // Timing-safe comparison only works when both strings have the same
    // length. Since we compare SHA-256 hashes, they should always be 64
    // chars, making the early length-check exit harmless.
    const shortKey = await hashApiKey("a");
    const longKey = await hashApiKey("a".repeat(1000));
    const emptyKey = await hashApiKey("");

    expect(shortKey).toHaveLength(64);
    expect(longKey).toHaveLength(64);
    expect(emptyKey).toHaveLength(64);

    // All hashes are distinct
    expect(shortKey).not.toBe(longKey);
    expect(shortKey).not.toBe(emptyKey);
    expect(longKey).not.toBe(emptyKey);
  });

  test("different keys with same prefix produce different hashes", async () => {
    const h1 = await hashApiKey("key-prefix-1");
    const h2 = await hashApiKey("key-prefix-2");
    expect(h1).not.toBe(h2);
  });
});
