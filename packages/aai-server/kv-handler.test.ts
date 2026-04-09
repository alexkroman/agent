// Copyright 2025 the AAI authors. MIT license.

import { KvRequestSchema } from "@alexkroman1/aai-core/protocol";
import { createUnstorageKv } from "@alexkroman1/aai-core/runtime";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { Env } from "./context.ts";
import { handleKv } from "./kv-handler.ts";
import { createTestStorage } from "./test-utils.ts";

const SLUG = "test-agent";

function createTestApp() {
  const storage = createTestStorage();
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("slug", SLUG);
    c.set("keyHash", "abc");
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: err.message }, 400);
    return c.json({ error: "unexpected" }, 500);
  });
  app.post("/kv", zValidator("json", KvRequestSchema), handleKv);
  return { app, storage };
}

async function postKv(
  app: Hono<Env>,
  storage: ReturnType<typeof createTestStorage>,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(
    "/kv",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { storage } as Record<string, unknown>,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("kv handler", () => {
  test("rejects invalid op", async () => {
    const { app, storage } = createTestApp();
    expect((await postKv(app, storage, { op: "invalid" })).status).toBe(400);
  });

  test("rejects missing key for get", async () => {
    const { app, storage } = createTestApp();
    expect((await postKv(app, storage, { op: "get" })).status).toBe(400);
  });

  test("get returns null for missing key", async () => {
    const { app, storage } = createTestApp();
    const { status, json } = await postKv(app, storage, { op: "get", key: "nope" });
    expect(status).toBe(200);
    expect(json.result).toBeNull();
  });

  test("get returns stored value", async () => {
    const { app, storage } = createTestApp();
    // Pre-populate via the KV interface with the same prefix the handler uses
    const kv = createUnstorageKv({ storage, prefix: `agents/${SLUG}/kv` });
    await kv.set("mykey", "myval");
    const { status, json } = await postKv(app, storage, { op: "get", key: "mykey" });
    expect(status).toBe(200);
    expect(json.result).toBe("myval");
  });

  test("set stores value and returns OK", async () => {
    const { app, storage } = createTestApp();
    const { status, json } = await postKv(app, storage, { op: "set", key: "k1", value: "v1" });
    expect(status).toBe(200);
    expect(json.result).toBe("OK");
    const kv = createUnstorageKv({ storage, prefix: `agents/${SLUG}/kv` });
    expect(await kv.get("k1")).toBe("v1");
  });

  test("del removes key and returns OK", async () => {
    const { app, storage } = createTestApp();
    const kv = createUnstorageKv({ storage, prefix: `agents/${SLUG}/kv` });
    await kv.set("k1", "v1");
    const { status, json } = await postKv(app, storage, { op: "del", key: "k1" });
    expect(status).toBe(200);
    expect(json.result).toBe("OK");
    expect(await kv.get("k1")).toBeNull();
  });

  test("returns 500 when storage throws", async () => {
    const { app, storage } = createTestApp();
    vi.spyOn(storage, "getItem").mockRejectedValue(new Error("storage down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { status, json } = await postKv(app, storage, { op: "get", key: "k" });
    expect(status).toBe(500);
    expect(json.error).toMatch(/KV get failed/);
  });

  test("set with expireIn forwards option", async () => {
    const { app, storage } = createTestApp();
    const { status, json } = await postKv(app, storage, {
      op: "set",
      key: "ttl",
      value: "v",
      expireIn: 60_000,
    });
    expect(status).toBe(200);
    expect(json.result).toBe("OK");
  });
});
