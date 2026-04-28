// Copyright 2025 the AAI authors. MIT license.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Intercept createRequire from node:module so that require("@pinecone-database/pinecone")
// returns a controlled fake — works even when the package is not installed.
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
var upsertRecords = vi.fn(); // eslint-disable-line no-var
var searchRecords = vi.fn(); // eslint-disable-line no-var
var deleteMany = vi.fn(); // eslint-disable-line no-var
var namespace = vi.fn(() => ({ upsertRecords, searchRecords, deleteMany })); // eslint-disable-line no-var
var index = vi.fn(() => ({ namespace })); // eslint-disable-line no-var
var PineconeFake = vi.fn(function (this: unknown) {
  // eslint-disable-line no-var
  return { index };
});

import { createPineconeVector } from "./pinecone-vector.ts";

beforeEach(() => {
  vi.clearAllMocks();
  PineconeFake.mockImplementation(function (this: unknown) {
    return { index };
  });
  index.mockImplementation(() => ({ namespace }));
  namespace.mockImplementation(() => ({ upsertRecords, searchRecords, deleteMany }));
});

describe("createPineconeVector", () => {
  it("threads namespace and index on upsert", async () => {
    const v = createPineconeVector({ apiKey: "k", index: "ix", namespace: "ns" });
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
    const v = createPineconeVector({ apiKey: "k", index: "ix", namespace: "ns" });
    const matches = await v.query("hello", { topK: 3, filter: { tag: "x" } });
    expect(searchRecords).toHaveBeenCalledWith({
      query: { inputs: { text: "hello" }, topK: 3, filter: { tag: "x" } },
      fields: ["*"],
    });
    expect(matches).toEqual([{ id: "doc-1", score: 0.9, text: "hello", metadata: { tag: "x" } }]);
  });

  it("delete with single id", async () => {
    const v = createPineconeVector({ apiKey: "k", index: "ix", namespace: "ns" });
    await v.delete("doc-1");
    expect(deleteMany).toHaveBeenCalledWith(["doc-1"]);
  });

  it("delete with array", async () => {
    const v = createPineconeVector({ apiKey: "k", index: "ix", namespace: "ns" });
    await v.delete(["a", "b"]);
    expect(deleteMany).toHaveBeenCalledWith(["a", "b"]);
  });
});
