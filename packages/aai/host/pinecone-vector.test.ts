// Copyright 2025 the AAI authors. MIT license.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire:
      () =>
      (id: string): unknown => {
        if (id === "@pinecone-database/pinecone") {
          return { Pinecone: PineconeFake };
        }
        return original.createRequire(import.meta.url)(id);
      },
  };
});

// Must use var (not const/let) to avoid TDZ when the vi.mock factory above
// is hoisted — the variables are referenced inside the factory closure.
/* eslint-disable no-var */
var upsertRecords = vi.fn();
var searchRecords = vi.fn();
var deleteMany = vi.fn();
var namespace = vi.fn(() => ({ upsertRecords, searchRecords, deleteMany }));
var index = vi.fn(() => ({ namespace }));
var PineconeFake = vi.fn(function (this: unknown) {
  return { index };
});

/* eslint-enable no-var */

import { createPineconeVector } from "./pinecone-vector.ts";

const config = { apiKey: "k", index: "ix", namespace: "ns" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createPineconeVector", () => {
  it("threads namespace and index on upsert", async () => {
    const v = createPineconeVector(config);
    await v.upsert("doc-1", "hello", { tag: "x" });
    expect(index).toHaveBeenCalledWith("ix");
    expect(namespace).toHaveBeenCalledWith("ns");
    expect(upsertRecords).toHaveBeenCalledWith([{ _id: "doc-1", text: "hello", tag: "x" }]);
  });

  it("calls searchRecords on query", async () => {
    searchRecords.mockResolvedValueOnce({
      result: {
        hits: [{ _id: "doc-1", _score: 0.9, fields: { text: "hello", tag: "x" } }],
      },
    });
    const v = createPineconeVector(config);
    const matches = await v.query("hello", { topK: 3, filter: { tag: "x" } });
    expect(searchRecords).toHaveBeenCalledWith({
      query: { inputs: { text: "hello" }, topK: 3, filter: { tag: "x" } },
      fields: ["*"],
    });
    expect(matches).toEqual([{ id: "doc-1", score: 0.9, text: "hello", metadata: { tag: "x" } }]);
  });

  it("delete with single id", async () => {
    const v = createPineconeVector(config);
    await v.delete("doc-1");
    expect(deleteMany).toHaveBeenCalledWith(["doc-1"]);
  });

  it("delete with array", async () => {
    const v = createPineconeVector(config);
    await v.delete(["a", "b"]);
    expect(deleteMany).toHaveBeenCalledWith(["a", "b"]);
  });
});
