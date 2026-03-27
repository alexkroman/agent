// Copyright 2025 the AAI authors. MIT license.

import { createTestEmbedFn, createUnstorageVectorStore } from "@alexkroman1/aai/unstorage-vector";
import type { VectorStore } from "@alexkroman1/aai/vector";
import type { Storage } from "unstorage";
import { beforeEach, describe, expect, test } from "vitest";
import { createTestStorage } from "./_test-utils.ts";

/** Create a scoped vector store with deterministic test embeddings. */
function createTestVector(storage: Storage, slug: string): VectorStore {
  return createUnstorageVectorStore({
    storage,
    blobKey: `agents/${slug}/vectors.json`,
    embedFn: createTestEmbedFn(),
  });
}

describe("createScopedVector", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createTestStorage();
  });

  test("upsert and query round-trip", async () => {
    const vec = createTestVector(storage, "test-agent");
    await vec.upsert("doc-1", "hello world", { source: "test" });
    const results = await vec.query("hello world", { topK: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("doc-1");
    expect(results[0]?.data).toBe("hello world");
    expect(results[0]?.metadata).toEqual({ source: "test" });
  });

  test("upsert without metadata", async () => {
    const vec = createTestVector(storage, "test-agent");
    await vec.upsert("doc-2", "some text");
    const results = await vec.query("some text", { topK: 1 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("doc-2");
  });

  test("delete removes vectors", async () => {
    const vec = createTestVector(storage, "test-agent");
    await vec.upsert("doc-1", "hello");
    await vec.delete("doc-1");
    const results = await vec.query("hello", { topK: 5 });
    expect(results.every((r) => r.id !== "doc-1")).toBe(true);
  });

  test("scoping isolates different agents", async () => {
    const vecA = createTestVector(storage, "agent-a");
    const vecB = createTestVector(storage, "agent-b");

    await vecA.upsert("doc", "data from A");
    await vecB.upsert("doc", "data from B");

    const resultsA = await vecA.query("data from A", { topK: 1 });
    expect(resultsA.length).toBeGreaterThan(0);
    expect(resultsA[0]?.data).toBe("data from A");

    const resultsB = await vecB.query("data from B", { topK: 1 });
    expect(resultsB.length).toBeGreaterThan(0);
    expect(resultsB[0]?.data).toBe("data from B");
  });

  test("query respects topK", async () => {
    const vec = createTestVector(storage, "test-agent");
    await vec.upsert("doc-1", "hello world");
    await vec.upsert("doc-2", "hello earth");
    await vec.upsert("doc-3", "hello universe");
    const results = await vec.query("hello", { topK: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});
