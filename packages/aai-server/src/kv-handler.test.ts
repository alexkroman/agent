// Copyright 2025 the AAI authors. MIT license.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { Env } from "./context.ts";
import { handleKv } from "./kv-handler.ts";

function createMockKvStore() {
  const store = new Map<string, string>();
  return {
    store,
    get: (_scope: unknown, key: string) => Promise.resolve(store.get(key) ?? null),
    set: (_scope: unknown, key: string, value: string, _ttl?: number) => {
      store.set(key, value);
      return Promise.resolve();
    },
    del: (_scope: unknown, key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
    keys: (_scope: unknown, _pattern?: string) => Promise.resolve([...store.keys()]),
    list: (_scope: unknown, prefix: string, _opts?: { limit?: number; reverse?: boolean }) =>
      Promise.resolve(
        [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      ),
  };
}

const SCOPE = { slug: "test-agent", keyHash: "abc" };

function createTestApp(kvStore: ReturnType<typeof createMockKvStore>) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("scope", SCOPE);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: err.message }, 400);
    return c.json({ error: "unexpected" }, 500);
  });
  app.post("/kv", handleKv);
  return { app, kvStore };
}

async function postKv(
  kvStore: ReturnType<typeof createMockKvStore>,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { app } = createTestApp(kvStore);
  const res = await app.request(
    "/kv",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { kvStore } as Record<string, unknown>,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("kv handler", () => {
  test("rejects invalid op", async () => {
    expect((await postKv(createMockKvStore(), { op: "invalid" })).status).toBe(400);
  });

  test("rejects missing key for get", async () => {
    expect((await postKv(createMockKvStore(), { op: "get" })).status).toBe(400);
  });

  test("get returns null for missing key", async () => {
    const { status, json } = await postKv(createMockKvStore(), { op: "get", key: "nope" });
    expect(status).toBe(200);
    expect(json.result).toBeNull();
  });

  test("get returns stored value", async () => {
    const kv = createMockKvStore();
    kv.store.set("mykey", "myval");
    const { status, json } = await postKv(kv, { op: "get", key: "mykey" });
    expect(status).toBe(200);
    expect(json.result).toBe("myval");
  });

  test("set stores value and returns OK", async () => {
    const kv = createMockKvStore();
    const { status, json } = await postKv(kv, { op: "set", key: "k1", value: "v1" });
    expect(status).toBe(200);
    expect(json.result).toBe("OK");
    expect(kv.store.get("k1")).toBe("v1");
  });

  test("del removes key and returns OK", async () => {
    const kv = createMockKvStore();
    kv.store.set("k1", "v1");
    const { status, json } = await postKv(kv, { op: "del", key: "k1" });
    expect(status).toBe(200);
    expect(json.result).toBe("OK");
    expect(kv.store.has("k1")).toBe(false);
  });

  test("keys returns all keys", async () => {
    const kv = createMockKvStore();
    kv.store.set("a", "1");
    kv.store.set("b", "2");
    const { status, json } = await postKv(kv, { op: "keys" });
    expect(status).toBe(200);
    expect(json.result).toEqual(["a", "b"]);
  });

  test("list returns entries matching prefix", async () => {
    const kv = createMockKvStore();
    kv.store.set("note:1", "a");
    kv.store.set("note:2", "b");
    kv.store.set("other:1", "c");
    const { status, json } = await postKv(kv, { op: "list", prefix: "note:" });
    expect(status).toBe(200);
    const result = json.result as { key: string; value: string }[];
    expect(result.length).toBe(2);
    expect(result.every((r) => r.key.startsWith("note:"))).toBe(true);
  });

  test("returns 500 when store throws", async () => {
    const kvStore = {
      store: new Map(),
      get: () => Promise.reject(new Error("db down")),
      set: () => Promise.reject(new Error("db down")),
      del: () => Promise.reject(new Error("db down")),
      keys: () => Promise.reject(new Error("db down")),
      list: () => Promise.reject(new Error("db down")),
    };
    const { status, json } = await postKv(kvStore, { op: "get", key: "x" });
    expect(status).toBe(500);
    expect(json.error).toContain("KV get failed: db down");
  });
});
