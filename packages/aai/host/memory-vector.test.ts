// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, it } from "vitest";
import { _resetMemoryVectorForTests, createMemoryVector } from "./memory-vector.ts";

afterEach(() => _resetMemoryVectorForTests());

describe("createMemoryVector", () => {
  it("returns empty array when querying an empty namespace", async () => {
    const v = createMemoryVector({ namespace: "ns1" });
    expect(await v.query("anything")).toEqual([]);
  });

  it("upsert + query returns the upserted record", async () => {
    const v = createMemoryVector({ namespace: "ns1" });
    await v.upsert("doc-1", "the quick brown fox", { tag: "anim" });
    const matches = await v.query("the quick brown fox");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      id: "doc-1",
      text: "the quick brown fox",
      metadata: { tag: "anim" },
    });
    expect(matches[0]?.score).toBeGreaterThan(0.9);
  });

  it("ranks more similar text higher than less similar text", async () => {
    const v = createMemoryVector({ namespace: "ns1" });
    await v.upsert("a", "exact match string");
    await v.upsert("b", "completely different content");
    const matches = await v.query("exact match string", { topK: 2 });
    expect(matches[0]?.id).toBe("a");
  });

  it("topK caps the number of results", async () => {
    const v = createMemoryVector({ namespace: "ns1" });
    for (let i = 0; i < 10; i++) await v.upsert(`id-${i}`, `text ${i}`);
    expect(await v.query("text", { topK: 3 })).toHaveLength(3);
  });

  it("idempotent: same id overwrites text and metadata", async () => {
    const v = createMemoryVector({ namespace: "ns1" });
    await v.upsert("doc", "v1", { tag: "old" });
    await v.upsert("doc", "v2", { tag: "new" });
    const matches = await v.query("v2");
    expect(matches[0]?.text).toBe("v2");
    expect(matches[0]?.metadata).toEqual({ tag: "new" });
  });

  it("delete removes by id", async () => {
    const v = createMemoryVector({ namespace: "ns1" });
    await v.upsert("a", "one");
    await v.upsert("b", "two");
    await v.delete("a");
    const ids = (await v.query("one")).map((m) => m.id);
    expect(ids).not.toContain("a");
  });

  it("delete accepts an array of ids", async () => {
    const v = createMemoryVector({ namespace: "ns1" });
    await v.upsert("a", "one");
    await v.upsert("b", "two");
    await v.delete(["a", "b"]);
    expect(await v.query("anything")).toEqual([]);
  });

  it("isolates namespaces", async () => {
    const a = createMemoryVector({ namespace: "ns1" });
    const b = createMemoryVector({ namespace: "ns2" });
    await a.upsert("doc", "in ns1");
    expect(await b.query("in ns1")).toEqual([]);
    expect((await a.query("in ns1"))[0]?.id).toBe("doc");
  });

  it("filter applies top-level exact-match", async () => {
    const v = createMemoryVector({ namespace: "ns1" });
    await v.upsert("a", "one", { kind: "x" });
    await v.upsert("b", "two", { kind: "y" });
    const matches = await v.query("one", { filter: { kind: "x" } });
    expect(matches.map((m) => m.id)).toEqual(["a"]);
  });

  it("rejects unsupported filter operators", async () => {
    const v = createMemoryVector({ namespace: "ns1" });
    await v.upsert("a", "one");
    await expect(v.query("one", { filter: { kind: { $in: ["x"] } } })).rejects.toThrow(/operator/i);
  });
});
