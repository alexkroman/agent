// Copyright 2025 the AAI authors. MIT license.

import { createStorage } from "unstorage";
import { describe, expect, test } from "vitest";
import { createTestEmbedFn } from "./_embeddings.ts";
import { createUnstorageVectorStore } from "./unstorage-vector.ts";

function makeVector() {
  return createUnstorageVectorStore({
    storage: createStorage(),
    embedFn: createTestEmbedFn(),
  });
}

describe("createUnstorageVectorStore", () => {
  test("upsert and query returns results", async () => {
    const vector = makeVector();
    await vector.upsert("doc-1", "The capital of France is Paris");
    const results = await vector.query("France Paris capital");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("doc-1");
    expect(results[0]?.score).toBeGreaterThan(0);
    expect(results[0]?.data).toBe("The capital of France is Paris");
  });

  test("query ranks similar text higher", async () => {
    const vector = makeVector();
    await vector.upsert("cats", "Cats are furry animals that purr");
    await vector.upsert("dogs", "Dogs are loyal animals that bark");
    await vector.upsert("cars", "Cars are vehicles with four wheels");

    const results = await vector.query("furry cats purr");
    expect(results[0]?.id).toBe("cats");
  });

  test("query returns empty for empty text", async () => {
    const vector = makeVector();
    await vector.upsert("doc-1", "some text");
    expect(await vector.query("")).toEqual([]);
    expect(await vector.query("   ")).toEqual([]);
  });

  test("query on empty store returns empty", async () => {
    const vector = makeVector();
    expect(await vector.query("anything")).toEqual([]);
  });

  test("topK limits results", async () => {
    const vector = makeVector();
    await vector.upsert("a", "alpha text");
    await vector.upsert("b", "beta text");
    await vector.upsert("c", "gamma text");

    const results = await vector.query("text", { topK: 2 });
    expect(results.length).toBe(2);
  });

  test("upsert replaces existing entry", async () => {
    const vector = makeVector();
    await vector.upsert("doc-1", "original text");
    await vector.upsert("doc-1", "updated text");

    const results = await vector.query("updated text");
    expect(results[0]?.data).toBe("updated text");
  });

  test("delete removes entries", async () => {
    const vector = makeVector();
    await vector.upsert("doc-1", "some text");
    await vector.upsert("doc-2", "other text");
    await vector.delete("doc-1");

    const results = await vector.query("some text");
    expect(results.every((r) => r.id !== "doc-1")).toBe(true);
  });

  test("delete with array of ids", async () => {
    const vector = makeVector();
    await vector.upsert("a", "text a");
    await vector.upsert("b", "text b");
    await vector.upsert("c", "text c");
    await vector.delete(["a", "c"]);

    const results = await vector.query("text");
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("b");
  });

  test("metadata is preserved", async () => {
    const vector = makeVector();
    await vector.upsert("doc-1", "test text", { source: "wiki", page: 42 });

    const results = await vector.query("test text");
    expect(results[0]?.metadata).toEqual({ source: "wiki", page: 42 });
  });

  test("entries without metadata return undefined metadata", async () => {
    const vector = makeVector();
    await vector.upsert("doc-1", "test text");

    const results = await vector.query("test text");
    expect(results[0]?.metadata).toBeUndefined();
  });

  test("data persists in the same storage instance", async () => {
    const storage = createStorage();
    const embedFn = createTestEmbedFn();

    const v1 = createUnstorageVectorStore({ storage, embedFn });
    await v1.upsert("doc-1", "persistent data");

    // New vector store instance over the same storage
    const v2 = createUnstorageVectorStore({ storage, embedFn });
    const results = await v2.query("persistent data");
    expect(results[0]?.id).toBe("doc-1");
  });

  test("separate storage instances are isolated", async () => {
    const v1 = makeVector();
    const v2 = makeVector();
    await v1.upsert("doc-1", "from v1");

    const results = await v2.query("from v1");
    expect(results.length).toBe(0);
  });

  test("score is between 0 and 1 for normalized vectors", async () => {
    const vector = makeVector();
    await vector.upsert("doc-1", "hello world");
    const results = await vector.query("hello world");
    expect(results[0]?.score).toBeGreaterThanOrEqual(0);
    expect(results[0]?.score).toBeLessThanOrEqual(1);
  });
});
