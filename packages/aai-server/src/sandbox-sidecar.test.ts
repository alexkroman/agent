// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, it, vi } from "vitest";
import type { KvStore } from "./kv.ts";
import { scopedKv, scopedVector, startSidecarServer } from "./sandbox-sidecar.ts";
import type { AgentScope } from "./scope-token.ts";
import type { ServerVectorStore } from "./vector.ts";

// ── Helpers ─────────────────────────────────────────────────────────────

const scopeA: AgentScope = { keyHash: "hashA", slug: "agent-a" };
const scopeB: AgentScope = { keyHash: "hashB", slug: "agent-b" };

function createMockKvStore(): KvStore {
  const store = new Map<string, { value: string; ttl?: number }>();

  return {
    get: vi.fn(async (_scope: AgentScope, key: string) => {
      const entry = store.get(`${_scope.keyHash}:${_scope.slug}:${key}`);
      return entry?.value ?? null;
    }),
    set: vi.fn(async (_scope: AgentScope, key: string, value: string, ttl?: number) => {
      store.set(`${_scope.keyHash}:${_scope.slug}:${key}`, {
        value,
        ...(ttl !== undefined && { ttl }),
      });
    }),
    delete: vi.fn(async (_scope: AgentScope, key: string) => {
      store.delete(`${_scope.keyHash}:${_scope.slug}:${key}`);
    }),
    keys: vi.fn(async (_scope: AgentScope, _pattern?: string) => []),
    list: vi.fn(async () => []),
  };
}

function createMockVectorStore(): ServerVectorStore {
  const namespaces = new Map<
    string,
    Map<string, { data: string; metadata?: Record<string, unknown> }>
  >();

  function getNamespace(scope: AgentScope) {
    const ns = `${scope.keyHash}:${scope.slug}`;
    if (!namespaces.has(ns)) namespaces.set(ns, new Map());
    // biome-ignore lint/style/noNonNullAssertion: just set above
    return namespaces.get(ns)!;
  }

  return {
    upsert: vi.fn(
      async (scope: AgentScope, id: string, data: string, metadata?: Record<string, unknown>) => {
        getNamespace(scope).set(id, { data, ...(metadata !== undefined && { metadata }) });
      },
    ),
    query: vi.fn(async (scope: AgentScope, _text: string, _topK?: number, _filter?: string) => {
      const ns = getNamespace(scope);
      return Array.from(ns.entries()).map(([id, entry]) => ({
        id,
        score: 1,
        data: entry.data,
        metadata: entry.metadata,
      }));
    }),
    delete: vi.fn(async (scope: AgentScope, ids: string[]) => {
      const ns = getNamespace(scope);
      for (const id of ids) ns.delete(id);
    }),
  };
}

// ── scopedKv ────────────────────────────────────────────────────────────

describe("scopedKv", () => {
  it("delegates get/set/delete to underlying store with correct scope", async () => {
    const kvStore = createMockKvStore();
    const kv = scopedKv(kvStore, scopeA);

    await kv.set("key1", { hello: "world" });
    expect(kvStore.set).toHaveBeenCalledWith(
      scopeA,
      "key1",
      JSON.stringify({ hello: "world" }),
      undefined,
    );

    await kv.get("key1");
    expect(kvStore.get).toHaveBeenCalledWith(scopeA, "key1");

    await kv.delete("key1");
    expect(kvStore.delete).toHaveBeenCalledWith(scopeA, "key1");
  });

  it("isolates KV data between different scopes", async () => {
    const kvStore = createMockKvStore();
    const kvA = scopedKv(kvStore, scopeA);
    const kvB = scopedKv(kvStore, scopeB);

    await kvA.set("shared-key", "value-a");
    await kvB.set("shared-key", "value-b");

    // Each scope writes with its own scope object
    expect(kvStore.set).toHaveBeenCalledWith(
      scopeA,
      "shared-key",
      JSON.stringify("value-a"),
      undefined,
    );
    expect(kvStore.set).toHaveBeenCalledWith(
      scopeB,
      "shared-key",
      JSON.stringify("value-b"),
      undefined,
    );

    // Reads from different scopes get different values
    await kvA.get("shared-key");
    expect(kvStore.get).toHaveBeenCalledWith(scopeA, "shared-key");

    await kvB.get("shared-key");
    expect(kvStore.get).toHaveBeenCalledWith(scopeB, "shared-key");
  });

  it("returns null for missing keys", async () => {
    const kvStore = createMockKvStore();
    const kv = scopedKv(kvStore, scopeA);
    const result = await kv.get("nonexistent");
    expect(result).toBeNull();
  });

  it("parses JSON values from get()", async () => {
    const kvStore = createMockKvStore();
    // Override get to return a JSON string
    kvStore.get = vi.fn(async () => JSON.stringify({ foo: "bar" }));
    const kv = scopedKv(kvStore, scopeA);

    const result = await kv.get("key1");
    expect(result).toEqual({ foo: "bar" });
  });

  it("returns raw string when JSON.parse fails in get()", async () => {
    const kvStore = createMockKvStore();
    // Return a non-JSON string
    kvStore.get = vi.fn(async () => "not-valid-json");
    const kv = scopedKv(kvStore, scopeA);

    const result = await kv.get("key1");
    expect(result).toBe("not-valid-json");
  });

  it("converts expireIn from milliseconds to seconds (ceiling)", async () => {
    const kvStore = createMockKvStore();
    const kv = scopedKv(kvStore, scopeA);

    // 1500ms → ceil(1.5) = 2 seconds
    await kv.set("ttl-key", "val", { expireIn: 1500 });
    expect(kvStore.set).toHaveBeenCalledWith(scopeA, "ttl-key", JSON.stringify("val"), 2);

    // 1000ms → exactly 1 second
    await kv.set("ttl-key2", "val", { expireIn: 1000 });
    expect(kvStore.set).toHaveBeenCalledWith(scopeA, "ttl-key2", JSON.stringify("val"), 1);

    // 500ms → ceil(0.5) = 1 second
    await kv.set("ttl-key3", "val", { expireIn: 500 });
    expect(kvStore.set).toHaveBeenCalledWith(scopeA, "ttl-key3", JSON.stringify("val"), 1);
  });

  it("passes undefined ttl when expireIn is not set", async () => {
    const kvStore = createMockKvStore();
    const kv = scopedKv(kvStore, scopeA);

    await kv.set("no-ttl", "val");
    expect(kvStore.set).toHaveBeenCalledWith(scopeA, "no-ttl", JSON.stringify("val"), undefined);

    await kv.set("no-ttl2", "val", {});
    expect(kvStore.set).toHaveBeenCalledWith(scopeA, "no-ttl2", JSON.stringify("val"), undefined);
  });

  it("delegates list() with options", async () => {
    const kvStore = createMockKvStore();
    const kv = scopedKv(kvStore, scopeA);

    await kv.list("prefix:", { limit: 10, reverse: true });
    expect(kvStore.list).toHaveBeenCalledWith(scopeA, "prefix:", { limit: 10, reverse: true });
  });

  it("delegates keys() with pattern", async () => {
    const kvStore = createMockKvStore();
    const kv = scopedKv(kvStore, scopeA);

    await kv.keys("user:*");
    expect(kvStore.keys).toHaveBeenCalledWith(scopeA, "user:*");
  });
});

// ── scopedVector ────────────────────────────────────────────────────────

describe("scopedVector", () => {
  it("delegates upsert/query/delete with correct scope", async () => {
    const vecStore = createMockVectorStore();
    const vec = scopedVector(vecStore, scopeA);

    await vec.upsert("id1", "hello world", { tag: "test" });
    expect(vecStore.upsert).toHaveBeenCalledWith(scopeA, "id1", "hello world", { tag: "test" });

    await vec.query("search text", { topK: 5, filter: "tag = 'test'" });
    expect(vecStore.query).toHaveBeenCalledWith(scopeA, "search text", 5, "tag = 'test'");

    await vec.delete("id1");
    expect(vecStore.delete).toHaveBeenCalledWith(scopeA, ["id1"]);
  });

  it("isolates vector data between different scopes", async () => {
    const vecStore = createMockVectorStore();
    const vecA = scopedVector(vecStore, scopeA);
    const vecB = scopedVector(vecStore, scopeB);

    await vecA.upsert("doc1", "data from A");
    await vecB.upsert("doc1", "data from B");

    expect(vecStore.upsert).toHaveBeenCalledWith(scopeA, "doc1", "data from A", undefined);
    expect(vecStore.upsert).toHaveBeenCalledWith(scopeB, "doc1", "data from B", undefined);
  });

  it("normalizes single id to array in delete()", async () => {
    const vecStore = createMockVectorStore();
    const vec = scopedVector(vecStore, scopeA);

    await vec.delete("single-id");
    expect(vecStore.delete).toHaveBeenCalledWith(scopeA, ["single-id"]);

    await vec.delete(["id1", "id2"]);
    expect(vecStore.delete).toHaveBeenCalledWith(scopeA, ["id1", "id2"]);
  });
});

// ── Sidecar HTTP server ─────────────────────────────────────────────────

describe("startSidecarServer", () => {
  it("starts on loopback and serves KV endpoints", async () => {
    const kvStore = createMockKvStore();
    kvStore.get = vi.fn(async () => JSON.stringify({ saved: true }));
    kvStore.keys = vi.fn(async () => ["k1", "k2"]);
    kvStore.list = vi.fn(async () => [{ key: "k1", value: "v1" }]);

    const kv = scopedKv(kvStore, scopeA);
    const { url, token, close } = await startSidecarServer(kv, undefined);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    try {
      // KV get
      const getRes = await fetch(`${url}/kv/get`, {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "test-key" }),
      });
      expect(getRes.ok).toBe(true);
      expect(await getRes.json()).toEqual({ saved: true });

      // KV set
      const setRes = await fetch(`${url}/kv/set`, {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "k", value: "v" }),
      });
      expect(setRes.ok).toBe(true);

      // KV delete
      const delRes = await fetch(`${url}/kv/delete`, {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "k" }),
      });
      expect(delRes.ok).toBe(true);

      // KV keys
      const keysRes = await fetch(`${url}/kv/keys`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(keysRes.ok).toBe(true);
      expect(await keysRes.json()).toEqual(["k1", "k2"]);

      // KV list
      const listRes = await fetch(`${url}/kv/list`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prefix: "" }),
      });
      expect(listRes.ok).toBe(true);
      expect(await listRes.json()).toEqual([{ key: "k1", value: "v1" }]);
    } finally {
      close();
    }
  });

  it("returns 503 when vector store is not configured", async () => {
    const kv = scopedKv(createMockKvStore(), scopeA);
    const { url, token, close } = await startSidecarServer(kv, undefined);

    try {
      const res = await fetch(`${url}/vec/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: "search" }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Vector store not configured");
    } finally {
      close();
    }
  });

  it("returns 400 for invalid request bodies", async () => {
    const kv = scopedKv(createMockKvStore(), scopeA);
    const { url, token, close } = await startSidecarServer(kv, undefined);

    try {
      const res = await fetch(`${url}/kv/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}), // missing required "key" field
      });
      expect(res.status).toBe(400);
    } finally {
      close();
    }
  });

  it("serves vector endpoints when vector store is configured", async () => {
    const vecStore = createMockVectorStore();
    const kv = scopedKv(createMockKvStore(), scopeA);
    const vec = scopedVector(vecStore, scopeA);
    const { url, token, close } = await startSidecarServer(kv, vec);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    try {
      // upsert
      const upsertRes = await fetch(`${url}/vec/upsert`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "d1", data: "hello" }),
      });
      expect(upsertRes.ok).toBe(true);

      // query
      const queryRes = await fetch(`${url}/vec/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "hello" }),
      });
      expect(queryRes.ok).toBe(true);
      const results = await queryRes.json();
      expect(Array.isArray(results)).toBe(true);

      // delete
      const removeRes = await fetch(`${url}/vec/delete`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: "d1" }),
      });
      expect(removeRes.ok).toBe(true);
    } finally {
      close();
    }
  });

  it("binds to 127.0.0.1 (loopback only)", async () => {
    const kv = scopedKv(createMockKvStore(), scopeA);
    const { url, close } = await startSidecarServer(kv, undefined);

    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      close();
    }
  });
});
