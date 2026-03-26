// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { createTestStore } from "./_test-utils.ts";
import { _clearHashCache, hashApiKey, verifySlugOwner } from "./auth.ts";

test("hashApiKey produces consistent 64-char hex", async () => {
  const h1 = await hashApiKey("key");
  const h2 = await hashApiKey("key");
  expect(h1).toBe(h2);
  expect(h1).toMatch(/^[0-9a-f]{64}$/);
  expect(await hashApiKey("other")).not.toBe(h1);
});

test("hashApiKey returns cached result on repeated calls", async () => {
  _clearHashCache();
  const h1 = await hashApiKey("cached-key");
  // Spy on crypto.subtle.digest to verify it's not called again
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let digestCalls = 0;
  crypto.subtle.digest = (...args: Parameters<typeof crypto.subtle.digest>) => {
    digestCalls++;
    return original(...args);
  };
  const h2 = await hashApiKey("cached-key");
  expect(h2).toBe(h1);
  expect(digestCalls).toBe(0);
  // New key should call digest
  await hashApiKey("new-key");
  expect(digestCalls).toBe(1);
  crypto.subtle.digest = original;
  _clearHashCache();
});

test("hashApiKey cache evicts oldest entry when full", async () => {
  _clearHashCache();
  // Fill cache to capacity (100 entries)
  for (let i = 0; i < 100; i++) {
    await hashApiKey(`evict-key-${i}`);
  }
  // Adding one more should evict the first
  await hashApiKey("evict-key-new");
  // Verify first key is no longer cached by spying
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let digestCalls = 0;
  crypto.subtle.digest = (...args: Parameters<typeof crypto.subtle.digest>) => {
    digestCalls++;
    return original(...args);
  };
  await hashApiKey("evict-key-0"); // should miss cache (was evicted)
  expect(digestCalls).toBe(1);
  await hashApiKey("evict-key-50"); // should still be cached
  expect(digestCalls).toBe(1);
  crypto.subtle.digest = original;
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
