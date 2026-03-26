// Copyright 2025 the AAI authors. MIT license.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createLanceDbVectorStore, createTestEmbedFn } from "./lancedb-vector.ts";

const embedFn = createTestEmbedFn();

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "aai-vec-test-"));
}

describe("createLanceDbVectorStore", () => {
  const tmpDirs: string[] = [];

  function tmpDir(): string {
    const d = makeTmpDir();
    tmpDirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tmpDirs.length = 0;
  });

  test("query returns empty for empty store", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    expect(await v.query("anything")).toEqual([]);
  });

  test("upsert and query returns matching entries", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("doc-1", "The capital of France is Paris.");
    await v.upsert("doc-2", "The capital of Germany is Berlin.");
    const results = await v.query("France capital");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // "France" appears in doc-1, so it should rank first
    expect(results[0]?.id).toBe("doc-1");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  test("query ranks better matches higher", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("a", "apple banana cherry");
    await v.upsert("b", "apple cherry");
    const results = await v.query("apple banana cherry");
    // "a" has all 3 words, should score higher
    expect(results[0]?.id).toBe("a");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  test("query respects topK", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("a", "word");
    await v.upsert("b", "word");
    await v.upsert("c", "word");
    const results = await v.query("word", { topK: 2 });
    expect(results.length).toBe(2);
  });

  test("upsert preserves metadata", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("doc", "some text", { source: "test" });
    const results = await v.query("some text");
    expect(results[0]?.metadata).toEqual({ source: "test" });
  });

  test("upsert overwrites existing entry", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("doc", "old text");
    await v.upsert("doc", "new text");
    const results = await v.query("new text");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.data).toBe("new text");
  });

  test("delete removes single entry", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("doc", "hello world");
    await v.delete("doc");
    expect(await v.query("hello world")).toEqual([]);
  });

  test("delete removes multiple entries", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("a", "hello world");
    await v.upsert("b", "hello world");
    await v.upsert("c", "hello world");
    await v.delete(["a", "b"]);
    const results = await v.query("hello world");
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("c");
  });

  test("query returns original data", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("doc", "The Capital of France");
    const results = await v.query("capital");
    expect(results[0]?.data).toBe("The Capital of France");
  });

  test("query skips non-matching entries", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("a", "apples and oranges");
    await v.upsert("b", "cats and dogs");
    const results = await v.query("apples");
    // "a" should be the top result; "b" may appear with low score
    expect(results[0]?.id).toBe("a");
  });

  test("query with empty string returns no results", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("doc", "some content");
    const results = await v.query("");
    expect(results).toEqual([]);
  });

  test("delete non-existent id does not throw", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await expect(v.delete("nonexistent")).resolves.toBeUndefined();
  });

  test("upsert without metadata results in undefined metadata", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("doc", "text");
    const results = await v.query("text");
    expect(results[0]?.metadata).toBeUndefined();
  });

  test("data persists across instances with same path", async () => {
    const dir = tmpDir();
    const v1 = await createLanceDbVectorStore({ path: dir, embedFn });
    await v1.upsert("doc", "persistent data");
    const v2 = await createLanceDbVectorStore({ path: dir, embedFn });
    const results = await v2.query("persistent");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.data).toBe("persistent data");
  });

  test("throws when no API key and no embedFn", async () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(createLanceDbVectorStore({ path: tmpDir() })).rejects.toThrow(/OPENAI_API_KEY/);
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
    }
  });

  test("uses openaiApiKey option when provided", async () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      // Should not throw — the key is provided via options, not env
      const v = await createLanceDbVectorStore({
        path: tmpDir(),
        openaiApiKey: "sk-test-fake-key",
      });
      // The store is created; actual embedding call would fail but creation succeeds
      expect(v).toBeDefined();
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
    }
  });

  test("query with filter option passes filter to search", async () => {
    const v = await createLanceDbVectorStore({ path: tmpDir(), embedFn });
    await v.upsert("doc-1", "hello world");
    await v.upsert("doc-2", "hello there");
    // Filter on the id column (a real LanceDB column)
    const results = await v.query("hello", { filter: 'id = "doc-1"' });
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("doc-1");
  });
});
