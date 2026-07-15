// Copyright 2025 the AAI authors. MIT license.

import { VectorRequestSchema } from "@alexkroman1/aai/protocol";
import type { Vector, VectorMatch, VectorQueryOptions } from "@alexkroman1/aai/runtime";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import type { HonoEnv } from "./context.ts";
import { handleVector } from "./vector-handler.ts";

const SLUG = "test-agent";

function createFakeVector(): Vector & {
  upsert: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    upsert: vi.fn(async () => undefined),
    query: vi.fn(async (): Promise<VectorMatch[]> => []),
    delete: vi.fn(async () => undefined),
  };
}

function createTestApp(vector: Vector) {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("slug", SLUG);
    c.set("keyHash", "abc");
    await next();
  });
  app.post("/vector", zValidator("json", VectorRequestSchema), (c) => handleVector(c, vector));
  return app;
}

async function postVector(
  app: Hono<HonoEnv>,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request("/vector", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("vector handler", () => {
  test("rejects invalid op with 400", async () => {
    const app = createTestApp(createFakeVector());
    const { status } = await postVector(app, { op: "bogus" });
    expect(status).toBe(400);
  });

  test("upsert forwards id, text, and metadata", async () => {
    const vector = createFakeVector();
    const app = createTestApp(vector);
    const { status, json } = await postVector(app, {
      op: "upsert",
      id: "doc-1",
      text: "hello world",
      metadata: { lang: "en" },
    });
    expect(status).toBe(200);
    expect(json).toEqual({ result: "OK" });
    expect(vector.upsert).toHaveBeenCalledWith("doc-1", "hello world", { lang: "en" });
  });

  test("query returns matches and omits unset options", async () => {
    const vector = createFakeVector();
    const matches: VectorMatch[] = [{ id: "doc-1", score: 0.9, text: "hello" }];
    vector.query.mockResolvedValue(matches);
    const app = createTestApp(vector);
    const { status, json } = await postVector(app, { op: "query", text: "hello" });
    expect(status).toBe(200);
    expect(json).toEqual({ result: matches });
    const opts = vector.query.mock.calls[0]?.[1] as VectorQueryOptions;
    expect(opts).toEqual({});
  });

  test("query forwards topK and filter when set", async () => {
    const vector = createFakeVector();
    const app = createTestApp(vector);
    await postVector(app, {
      op: "query",
      text: "hello",
      topK: 3,
      filter: { lang: "en" },
    });
    expect(vector.query).toHaveBeenCalledWith("hello", { topK: 3, filter: { lang: "en" } });
  });

  test("delete forwards ids", async () => {
    const vector = createFakeVector();
    const app = createTestApp(vector);
    const { status, json } = await postVector(app, { op: "delete", ids: ["a", "b"] });
    expect(status).toBe(200);
    expect(json).toEqual({ result: "OK" });
    expect(vector.delete).toHaveBeenCalledWith(["a", "b"]);
  });

  test("provider failure returns 500 with op in message and logs the error", async () => {
    const vector = createFakeVector();
    vector.query.mockRejectedValue(new Error("pinecone down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createTestApp(vector);
    const { status, json } = await postVector(app, { op: "query", text: "hello" });
    expect(status).toBe(500);
    expect(json).toEqual({ error: "Vector query failed" });
    expect(consoleError).toHaveBeenCalledWith(
      "Vector operation failed",
      expect.objectContaining({ op: "query", slug: SLUG, error: "pinecone down" }),
    );
  });
});
