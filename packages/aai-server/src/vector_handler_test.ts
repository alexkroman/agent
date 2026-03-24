// Copyright 2025 the AAI authors. MIT license.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createTestVectorStore } from "./_test_utils.ts";
import type { Env } from "./context.ts";
import { handleVector } from "./vector_handler.ts";

const SCOPE = { slug: "test-agent", keyHash: "abc" };

function createTestApp(vectorStore?: ReturnType<typeof createTestVectorStore>) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("slug", SCOPE.slug);
    c.set("keyHash", SCOPE.keyHash);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: err.message }, 400);
    return c.json({ error: "unexpected" }, 500);
  });
  app.post("/vector", handleVector);
  return { app, vectorStore };
}

async function postVector(
  body: unknown,
  vectorStore?: ReturnType<typeof createTestVectorStore>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const vs = vectorStore ?? createTestVectorStore();
  const { app } = createTestApp(vs);
  const res = await app.request(
    "/vector",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { vectorStore: vs } as Record<string, unknown>,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("vector handler", () => {
  test("rejects when store not configured", async () => {
    const { app } = createTestApp(undefined);
    const res = await app.request(
      "/vector",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "query", text: "hello" }),
      },
      { vectorStore: undefined } as Record<string, unknown>,
    );
    expect(res.status).toBe(503);
  });

  test("rejects invalid request body", async () => {
    expect((await postVector({ op: "badop" })).status).toBe(400);
  });

  test("upsert stores data and returns OK", async () => {
    const vs = createTestVectorStore();
    const { status, json } = await postVector(
      { op: "upsert", id: "doc1", data: "hello world" },
      vs,
    );
    expect(status).toBe(200);
    expect(json.result).toBe("OK");
  });

  test("query returns matching results", async () => {
    const vs = createTestVectorStore();
    await vs.upsert(SCOPE, "doc1", "hello world");
    await vs.upsert(SCOPE, "doc2", "goodbye world");
    const { status, json } = await postVector({ op: "query", text: "hello" }, vs);
    expect(status).toBe(200);
    const result = json.result as { id: string; score: number }[];
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.id).toBe("doc1");
  });

  test("query returns empty for no matches", async () => {
    const { status, json } = await postVector({ op: "query", text: "nothing" });
    expect(status).toBe(200);
    expect((json.result as unknown[]).length).toBe(0);
  });

  test("returns 500 when store throws", async () => {
    const failingStore = {
      upsert: () => Promise.reject(new Error("vec down")),
      query: () => Promise.reject(new Error("vec down")),
      remove: () => Promise.reject(new Error("vec down")),
    };
    const { app } = createTestApp(
      failingStore as unknown as ReturnType<typeof createTestVectorStore>,
    );
    const res = await app.request(
      "/vector",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "query", text: "hello" }),
      },
      { vectorStore: failingStore } as Record<string, unknown>,
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as Record<string, unknown>).error).toContain(
      "Vector operation failed",
    );
  });
});
