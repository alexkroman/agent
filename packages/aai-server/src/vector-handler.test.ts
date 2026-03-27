// Copyright 2025 the AAI authors. MIT license.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createTestStorage } from "./_test-utils.ts";
import type { Env } from "./context.ts";
import { createScopedVector } from "./scoped-storage.ts";
import { handleVector } from "./vector-handler.ts";

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
  app.post("/vector", handleVector);
  return { app, storage };
}

async function postVector(
  app: Hono<Env>,
  storage: ReturnType<typeof createTestStorage>,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(
    "/vector",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { storage } as Record<string, unknown>,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("vector handler", () => {
  test("rejects invalid request body", async () => {
    const { app, storage } = createTestApp();
    expect((await postVector(app, storage, { op: "badop" })).status).toBe(400);
  });

  test("upsert stores data and returns OK", async () => {
    const { app, storage } = createTestApp();
    const { status, json } = await postVector(app, storage, {
      op: "upsert",
      id: "doc1",
      data: "hello world",
    });
    expect(status).toBe(200);
    expect(json.result).toBe("OK");
  });

  test("query returns matching results", async () => {
    const { app, storage } = createTestApp();
    // Pre-populate via the scoped vector interface
    const vec = createScopedVector(storage, SLUG);
    await vec.upsert("doc1", "hello world");
    await vec.upsert("doc2", "goodbye world");
    const { status, json } = await postVector(app, storage, { op: "query", text: "hello" });
    expect(status).toBe(200);
    const result = json.result as { id: string; score: number }[];
    expect(result.length).toBeGreaterThan(0);
  });

  test("query returns empty for no matches", async () => {
    const { app, storage } = createTestApp();
    const { status, json } = await postVector(app, storage, { op: "query", text: "nothing" });
    expect(status).toBe(200);
    expect((json.result as unknown[]).length).toBe(0);
  });

  test("delete removes vectors and returns OK", async () => {
    const { app, storage } = createTestApp();
    const vec = createScopedVector(storage, SLUG);
    await vec.upsert("doc1", "hello world");
    const { status, json } = await postVector(app, storage, { op: "delete", ids: ["doc1"] });
    expect(status).toBe(200);
    expect(json.result).toBe("OK");
  });
});
