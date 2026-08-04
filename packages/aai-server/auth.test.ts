// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { hashApiKey, verifyApiKeyHash, verifySlugOwner } from "./secrets.ts";
import { createTestStore, TEST_AGENT_CONFIG } from "./test-utils.ts";

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
  expect(result.status).toBe("unclaimed");
  expect("keyHash" in result).toBe(false);
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

describe("auth timing safety", () => {
  test("digests have consistent format regardless of key length", () => {
    const shortKey = hashApiKey("a");
    const longKey = hashApiKey("a".repeat(1000));
    const emptyKey = hashApiKey("");

    const pattern = /^sha256:[0-9a-f]{64}$/;
    expect(shortKey).toMatch(pattern);
    expect(longKey).toMatch(pattern);
    expect(emptyKey).toMatch(pattern);

    expect(verifyApiKeyHash("a", shortKey)).toBe(true);
    expect(verifyApiKeyHash("a".repeat(1000), longKey)).toBe(true);
    expect(verifyApiKeyHash("", emptyKey)).toBe(true);
  });
});
