// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { hashApiKey, verifyApiKeyHash, verifySlugOwner } from "./secrets.ts";
import { createTestStore, TEST_AGENT_CONFIG } from "./test-utils.ts";

test("hashApiKey produces PBKDF2 format", async () => {
  const h = await hashApiKey("key");
  expect(h).toMatch(/^pbkdf2:600000:/);
  // Same key hashes differently each time (random salt)
  const h2 = await hashApiKey("key");
  expect(h).not.toBe(h2);
  // But both verify against the original key
  expect(await verifyApiKeyHash("key", h)).toBe(true);
  expect(await verifyApiKeyHash("key", h2)).toBe(true);
  // Different key does not verify
  expect(await verifyApiKeyHash("other", h)).toBe(false);
});

test("verifySlugOwner returns unclaimed for missing slug", async () => {
  const store = createTestStore();
  const result = await verifySlugOwner("key1", { slug: "my-agent", store });
  expect(result.status).toBe("unclaimed");
  expect("keyHash" in result).toBe(true);
  if (result.status === "unclaimed") {
    expect(result.keyHash).toMatch(/^pbkdf2:/);
  }
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
  test("PBKDF2 hashes have consistent format", async () => {
    const shortKey = await hashApiKey("a");
    const longKey = await hashApiKey("a".repeat(1000));
    const emptyKey = await hashApiKey("");

    const pattern = /^pbkdf2:600000:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
    expect(shortKey).toMatch(pattern);
    expect(longKey).toMatch(pattern);
    expect(emptyKey).toMatch(pattern);

    expect(await verifyApiKeyHash("a", shortKey)).toBe(true);
    expect(await verifyApiKeyHash("a".repeat(1000), longKey)).toBe(true);
    expect(await verifyApiKeyHash("", emptyKey)).toBe(true);
  });
});
