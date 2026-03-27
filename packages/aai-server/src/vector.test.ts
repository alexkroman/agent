// Copyright 2025 the AAI authors. MIT license.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentScope } from "./scope-token.ts";

type QueryResult = {
  id: string | number;
  score: number;
  data: string | null;
  metadata: Record<string, unknown> | null;
};

const indexMethods = {
  upsert: vi.fn(async () => undefined),
  query: vi.fn(async (): Promise<QueryResult[]> => []),
  delete: vi.fn(async () => undefined),
};

vi.mock("@upstash/vector", () => ({
  Index: class MockIndex {
    upsert = indexMethods.upsert;
    query = indexMethods.query;
    delete = indexMethods.delete;
  },
}));

const SCOPE: AgentScope = { keyHash: "abc", slug: "test-agent" };
const NS = "abc:test-agent";

const { createVectorStore } = await import("./vector.ts");

describe("createVectorStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("upsert sends data with correct namespace", async () => {
    const vs = createVectorStore("http://localhost", "token");
    await vs.upsert(SCOPE, "doc-1", "hello world", { source: "test" });
    expect(indexMethods.upsert).toHaveBeenCalledWith(
      { id: "doc-1", data: "hello world", metadata: { source: "test" } },
      { namespace: NS },
    );
  });

  test("upsert without metadata", async () => {
    const vs = createVectorStore("http://localhost", "token");
    await vs.upsert(SCOPE, "doc-2", "some text");
    expect(indexMethods.upsert).toHaveBeenCalledWith(
      { id: "doc-2", data: "some text", metadata: undefined },
      { namespace: NS },
    );
  });

  test("query passes topK and filter", async () => {
    indexMethods.query.mockResolvedValueOnce([
      { id: "doc-1", score: 0.95, data: "hello", metadata: { k: "v" } },
      { id: 42, score: 0.8, data: null, metadata: null },
    ]);
    const vs = createVectorStore("http://localhost", "token");

    const results = await vs.query(SCOPE, "search text", 5, "source = 'test'");
    expect(indexMethods.query).toHaveBeenCalledWith(
      {
        data: "search text",
        topK: 5,
        includeData: true,
        includeMetadata: true,
        filter: "source = 'test'",
      },
      { namespace: NS },
    );
    expect(results).toEqual([
      { id: "doc-1", score: 0.95, data: "hello", metadata: { k: "v" } },
      { id: "42", score: 0.8, data: null, metadata: null },
    ]);
  });

  test("query uses default topK of 10", async () => {
    indexMethods.query.mockResolvedValueOnce([]);
    const vs = createVectorStore("http://localhost", "token");

    await vs.query(SCOPE, "search text");
    expect(indexMethods.query).toHaveBeenCalledWith(
      {
        data: "search text",
        topK: 10,
        includeData: true,
        includeMetadata: true,
      },
      { namespace: NS },
    );
  });

  test("query without filter omits filter field", async () => {
    indexMethods.query.mockResolvedValueOnce([]);
    const vs = createVectorStore("http://localhost", "token");

    await vs.query(SCOPE, "text", 3);
    const callArgs = (indexMethods.query.mock.calls[0] as unknown[])[0];
    expect(callArgs).not.toHaveProperty("filter");
  });

  test("remove deletes ids in correct namespace", async () => {
    const vs = createVectorStore("http://localhost", "token");
    await vs.remove(SCOPE, ["id-1", "id-2"]);
    expect(indexMethods.delete).toHaveBeenCalledWith(["id-1", "id-2"], { namespace: NS });
  });

  test("scoping isolates different agents", async () => {
    const vs = createVectorStore("http://localhost", "token");
    const scope1: AgentScope = { keyHash: "h1", slug: "agent-a" };
    const scope2: AgentScope = { keyHash: "h2", slug: "agent-b" };

    await vs.upsert(scope1, "doc", "data1");
    await vs.upsert(scope2, "doc", "data2");

    expect(indexMethods.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "doc", data: "data1" }),
      { namespace: "h1:agent-a" },
    );
    expect(indexMethods.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "doc", data: "data2" }),
      { namespace: "h2:agent-b" },
    );
  });

  test("query converts numeric id to string", async () => {
    indexMethods.query.mockResolvedValueOnce([{ id: 123, score: 0.5, data: "x", metadata: {} }]);
    const vs = createVectorStore("http://localhost", "token");

    const results = await vs.query(SCOPE, "test");
    expect(results).toMatchObject([{ id: "123" }]);
  });
});
