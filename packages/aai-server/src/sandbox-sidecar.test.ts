// Copyright 2025 the AAI authors. MIT license.

import type { Kv } from "@alexkroman1/aai/kv";
import type { VectorStore } from "@alexkroman1/aai/vector";
import { describe, expect, it, vi } from "vitest";
import { startSidecarServer } from "./sandbox-sidecar.ts";

// ── Helpers ─────────────────────────────────────────────────────────────

function createMockKv(): Kv {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null) as Kv["get"],
    set: vi.fn(async (key: string, value: unknown, _options?: { expireIn?: number }) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    keys: vi.fn(async (_pattern?: string) => [...store.keys()]),
    list: vi.fn(async () => []) as Kv["list"],
  };
}

function createMockVectorStore(): VectorStore {
  const docs = new Map<string, { data: string; metadata?: Record<string, unknown> }>();
  return {
    upsert: vi.fn(async (id: string, data: string, metadata?: Record<string, unknown>) => {
      docs.set(id, { data, ...(metadata !== undefined && { metadata }) });
    }),
    query: vi.fn(async (_text: string, _opts?: { topK?: number; filter?: string }) =>
      Array.from(docs.entries()).map(([id, entry]) => ({
        id,
        score: 1,
        data: entry.data,
        metadata: entry.metadata,
      })),
    ),
    delete: vi.fn(async (ids: string | string[]) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) docs.delete(id);
    }),
  };
}

// ── Sidecar HTTP server ─────────────────────────────────────────────────

describe("startSidecarServer", () => {
  it("starts on loopback and serves KV endpoints", async () => {
    const kv = createMockKv();
    kv.get = vi.fn(async () => ({ saved: true })) as Kv["get"];
    kv.keys = vi.fn(async () => ["k1", "k2"]);
    kv.list = vi.fn(async () => [{ key: "k1", value: "v1" }]) as Kv["list"];

    const { url, close } = await startSidecarServer(kv, undefined);
    const headers = { "Content-Type": "application/json" };

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

      // KV del
      const delRes = await fetch(`${url}/kv/del`, {
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
    const kv = createMockKv();
    const { url, close } = await startSidecarServer(kv, undefined);

    try {
      const res = await fetch(`${url}/vec/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    const kv = createMockKv();
    const { url, close } = await startSidecarServer(kv, undefined);

    try {
      const res = await fetch(`${url}/kv/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}), // missing required "key" field
      });
      expect(res.status).toBe(400);
    } finally {
      close();
    }
  });

  it("serves vector endpoints when vector store is configured", async () => {
    const vecStore = createMockVectorStore();
    const kv = createMockKv();
    const { url, close } = await startSidecarServer(kv, vecStore);
    const headers = { "Content-Type": "application/json" };

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
    const kv = createMockKv();
    const { url, close } = await startSidecarServer(kv, undefined);

    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      close();
    }
  });
});

// ── Fetch proxy ──────────────────────────────────────────────────────

describe("sidecar /fetch proxy", () => {
  it("blocks requests to private IPs (SSRF protection)", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecarServer(kv, undefined);

    try {
      const res = await fetch(`${sidecar.url}/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }),
      });
      // ssrfSafeFetch throws, which the sidecar catches and returns as 500
      expect(res.ok).toBe(false);
      expect(res.status).toBe(500);
    } finally {
      sidecar.close();
    }
  });

  it("blocks requests to localhost", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecarServer(kv, undefined);

    try {
      const res = await fetch(`${sidecar.url}/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://127.0.0.1:8080/secret" }),
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("private address");
    } finally {
      sidecar.close();
    }
  });

  it("returns 400 for invalid request body", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecarServer(kv, undefined);

    try {
      const res = await fetch(`${sidecar.url}/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ not_a_url: true }),
      });
      expect(res.status).toBe(400);
    } finally {
      sidecar.close();
    }
  });

  it("blocks requests to .internal domains", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecarServer(kv, undefined);

    try {
      const res = await fetch(`${sidecar.url}/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://metadata.google.internal/computeMetadata/v1/" }),
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("private address");
    } finally {
      sidecar.close();
    }
  });
});
