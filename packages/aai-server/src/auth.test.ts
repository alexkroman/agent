// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { createTestStore } from "./_test-utils.ts";
import { hashApiKey, timingSafeCompare, verifySlugOwner } from "./auth.ts";

test("hashApiKey produces consistent 64-char hex", async () => {
  const h1 = await hashApiKey("key");
  const h2 = await hashApiKey("key");
  expect(h1).toBe(h2);
  expect(h1).toMatch(/^[0-9a-f]{64}$/);
  expect(await hashApiKey("other")).not.toBe(h1);
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

test("timingSafeCompare returns true for identical strings", () => {
  expect(timingSafeCompare("abc", "abc")).toBe(true);
  expect(timingSafeCompare("", "")).toBe(true);
});

test("timingSafeCompare returns false for same-length different strings", () => {
  expect(timingSafeCompare("abc", "abd")).toBe(false);
  expect(timingSafeCompare("aaa", "bbb")).toBe(false);
});

test("timingSafeCompare returns false for different-length strings", () => {
  expect(timingSafeCompare("short", "longer")).toBe(false);
  expect(timingSafeCompare("a", "ab")).toBe(false);
  expect(timingSafeCompare("abc", "")).toBe(false);
});

test("timingSafeCompare works with SHA-256 hex digests", async () => {
  const h1 = await hashApiKey("key1");
  const h2 = await hashApiKey("key1");
  const h3 = await hashApiKey("key2");
  expect(timingSafeCompare(h1, h2)).toBe(true);
  expect(timingSafeCompare(h1, h3)).toBe(false);
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
