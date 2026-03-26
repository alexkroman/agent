// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createMemoryVectorStore } from "./vector.ts";

describe("createMemoryVectorStore", () => {
  test("query returns empty for empty store", async () => {
    const v = createMemoryVectorStore();
    expect(await v.query("anything")).toEqual([]);
  });

  test("upsert and query returns matching entries", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("doc-1", "The capital of France is Paris.");
    await v.upsert("doc-2", "The capital of Germany is Berlin.");
    const results = await v.query("France capital");
    expect(results.length).toBe(2);
    expect(results[0]?.id).toBe("doc-1");
    expect(results[0]?.score).toBe(1); // both words match
  });

  test("query scores by word match ratio", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("a", "apple banana cherry");
    await v.upsert("b", "apple cherry");
    const results = await v.query("apple banana cherry");
    expect(results[0]?.id).toBe("a"); // 3/3 matches
    expect(results[0]?.score).toBe(1);
    expect(results[1]?.id).toBe("b"); // 2/3 matches
  });

  test("query respects topK", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("a", "word");
    await v.upsert("b", "word");
    await v.upsert("c", "word");
    const results = await v.query("word", { topK: 2 });
    expect(results.length).toBe(2);
  });

  test("query is case insensitive", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("doc", "Hello World");
    const results = await v.query("hello");
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("doc");
  });

  test("upsert preserves metadata", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("doc", "some text", { source: "test" });
    const results = await v.query("some text");
    expect(results[0]?.metadata).toEqual({ source: "test" });
  });

  test("upsert overwrites existing entry", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("doc", "old text");
    await v.upsert("doc", "new text");
    expect(await v.query("old")).toEqual([]);
    const results = await v.query("new text");
    expect(results.length).toBe(1);
    expect(results[0]?.data).toBe("new text");
  });

  test("delete removes single entry", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("doc", "hello");
    await v.delete("doc");
    expect(await v.query("hello")).toEqual([]);
  });

  test("delete removes multiple entries", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("a", "hello");
    await v.upsert("b", "hello");
    await v.upsert("c", "hello");
    await v.delete(["a", "b"]);
    const results = await v.query("hello");
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("c");
  });

  test("query returns original data", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("doc", "The Capital of France");
    const results = await v.query("capital");
    expect(results[0]?.data).toBe("The Capital of France");
  });

  test("query skips non-matching entries", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("a", "apples and oranges");
    await v.upsert("b", "cats and dogs");
    const results = await v.query("apples");
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("a");
  });

  test("query with empty string returns no results", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("doc", "some content");
    const results = await v.query("");
    expect(results).toEqual([]);
  });

  test("delete non-existent id does not throw", async () => {
    const v = createMemoryVectorStore();
    await expect(v.delete("nonexistent")).resolves.toBeUndefined();
  });

  test("upsert without metadata results in undefined metadata", async () => {
    const v = createMemoryVectorStore();
    await v.upsert("doc", "text");
    const results = await v.query("text");
    expect(results[0]?.metadata).toBeUndefined();
  });
});
