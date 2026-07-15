// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Kv } from "../sdk/kv.ts";
import type { Vector, VectorMatch } from "../sdk/vector.ts";
import { makeAgent, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import { createServer } from "./server.ts";

function makeRuntime(opts: { name?: string; shutdownTimeoutMs?: number } = {}) {
  const agent = makeAgent(opts.name ? { name: opts.name } : {});
  return {
    agent,
    runtime: createRuntime({
      agent,
      env: {},
      logger: silentLogger,
      ...(opts.shutdownTimeoutMs ? { shutdownTimeoutMs: opts.shutdownTimeoutMs } : {}),
    }),
  };
}

describe("createServer", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  test("returns an object with listen and close", () => {
    const { runtime } = makeRuntime();
    server = createServer({ runtime, logger: silentLogger });
    expect(server).toHaveProperty("listen");
    expect(server).toHaveProperty("close");
  });

  test("/health returns ok JSON", async () => {
    const { runtime } = makeRuntime({ name: "health-agent" });
    server = createServer({ runtime, name: "health-agent", logger: silentLogger });
    await server.listen(0);
  });

  test("listen and close lifecycle works", async () => {
    const { runtime } = makeRuntime();
    server = createServer({ runtime, logger: silentLogger });
    await server.listen(0);
  });

  test("/ returns default HTML with escaped agent name", async () => {
    const name = '<script>alert("xss")</script>';
    const { runtime } = makeRuntime({ name });
    server = createServer({ runtime, name, logger: silentLogger });
    await server.listen(0);

    const res = await fetch(`http://localhost:${server.port}/`);
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Agent server running.");
  });

  test("/ returns custom clientHtml when provided", async () => {
    const { runtime } = makeRuntime();
    server = createServer({
      runtime,
      clientHtml: "<h1>Custom</h1>",
      logger: silentLogger,
    });
    await server.listen(0);

    const res = await fetch(`http://localhost:${server.port}/`);
    const html = await res.text();
    expect(html).toBe("<h1>Custom</h1>");
  });

  test("/health returns JSON with agent name", async () => {
    const { runtime } = makeRuntime({ name: "my-agent" });
    server = createServer({ runtime, name: "my-agent", logger: silentLogger });
    await server.listen(0);

    const res = await fetch(`http://localhost:${server.port}/health`);
    const json = await res.json();
    expect(json).toEqual({ status: "ok", name: "my-agent" });
  });

  test("404 triggers error-level logging", async () => {
    const { runtime } = makeRuntime();
    server = createServer({ runtime, logger: silentLogger });
    await server.listen(0);

    await fetch(`http://localhost:${server.port}/nonexistent-path`);
    await vi.waitFor(() => expect(silentLogger.error).toHaveBeenCalled());
  });

  test("close is safe to call without listen", async () => {
    const { runtime } = makeRuntime();
    server = createServer({ runtime, logger: silentLogger });
    await server.close();
    server = null;
  });

  test("accepts shutdownTimeoutMs in runtime options", () => {
    const { runtime } = makeRuntime({ shutdownTimeoutMs: 5000 });
    server = createServer({ runtime, logger: silentLogger });
    expect(server).toHaveProperty("close");
  });

  test("throws when clientHtml and clientDir are both provided", () => {
    const { runtime } = makeRuntime();
    expect(() =>
      createServer({ runtime, clientHtml: "<h1>x</h1>", clientDir: "/tmp", logger: silentLogger }),
    ).toThrow("mutually exclusive");
  });

  test("responses carry security headers", async () => {
    const { runtime } = makeRuntime();
    server = createServer({ runtime, logger: silentLogger });
    await server.listen(0);

    const res = await fetch(`http://localhost:${server.port}/health`);
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});

describe("createServer /kv endpoint", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  function makeKv(): Kv & { get: ReturnType<typeof vi.fn> } {
    return {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
  }

  async function listenWithKv(kv: Kv): Promise<string> {
    const { runtime } = makeRuntime();
    server = createServer({ runtime, kv, logger: silentLogger });
    await server.listen(0);
    return `http://localhost:${server.port}`;
  }

  test("returns 400 when key query parameter is missing", async () => {
    const base = await listenWithKv(makeKv());
    const res = await fetch(`${base}/kv`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing key query parameter" });
  });

  test("returns the stored value as JSON", async () => {
    const kv = makeKv();
    kv.get.mockResolvedValue({ count: 3 });
    const base = await listenWithKv(kv);
    const res = await fetch(`${base}/kv?key=counter`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 3 });
    expect(kv.get).toHaveBeenCalledWith("counter");
  });

  test("returns 404 with null body for missing keys", async () => {
    const base = await listenWithKv(makeKv());
    const res = await fetch(`${base}/kv?key=missing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toBeNull();
  });

  test("returns 500 when the KV store fails", async () => {
    const kv = makeKv();
    kv.get.mockRejectedValue(new Error("redis down"));
    const base = await listenWithKv(kv);
    const res = await fetch(`${base}/kv?key=x`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "KV error" });
  });

  test("/kv is 404 when no kv is configured", async () => {
    const { runtime } = makeRuntime();
    server = createServer({ runtime, logger: silentLogger });
    await server.listen(0);
    const res = await fetch(`http://localhost:${server.port}/kv?key=x`);
    expect(res.status).toBe(404);
  });
});

describe("createServer /vector endpoint", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  function makeVector(): Vector & {
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

  async function listenWithVector(vector: Vector): Promise<string> {
    const { runtime } = makeRuntime();
    server = createServer({ runtime, vector, logger: silentLogger });
    await server.listen(0);
    return `http://localhost:${server.port}`;
  }

  async function postVector(base: string, body: unknown): Promise<Response> {
    return fetch(`${base}/vector`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("rejects malformed ops with 400", async () => {
    const base = await listenWithVector(makeVector());
    const res = await postVector(base, { op: "bogus" });
    expect(res.status).toBe(400);
  });

  test("upsert forwards id, text, and metadata", async () => {
    const vector = makeVector();
    const base = await listenWithVector(vector);
    const res = await postVector(base, {
      op: "upsert",
      id: "doc-1",
      text: "hello",
      metadata: { lang: "en" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "OK" });
    expect(vector.upsert).toHaveBeenCalledWith("doc-1", "hello", { lang: "en" });
  });

  test("query forwards topK and filter and returns matches", async () => {
    const vector = makeVector();
    const matches: VectorMatch[] = [{ id: "doc-1", score: 0.9, text: "hello" }];
    vector.query.mockResolvedValue(matches);
    const base = await listenWithVector(vector);
    const res = await postVector(base, { op: "query", text: "hi", topK: 2, filter: { a: 1 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: matches });
    expect(vector.query).toHaveBeenCalledWith("hi", { topK: 2, filter: { a: 1 } });
  });

  test("delete forwards ids", async () => {
    const vector = makeVector();
    const base = await listenWithVector(vector);
    const res = await postVector(base, { op: "delete", ids: ["a"] });
    expect(res.status).toBe(200);
    expect(vector.delete).toHaveBeenCalledWith(["a"]);
  });

  test("returns 500 when the vector store fails", async () => {
    const vector = makeVector();
    vector.query.mockRejectedValue(new Error("pinecone down"));
    const base = await listenWithVector(vector);
    const res = await postVector(base, { op: "query", text: "hi" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "pinecone down" });
  });
});

describe("createServer static client dir", () => {
  let server: ReturnType<typeof createServer> | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function listenWithClientDir(): Promise<string> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-server-test-"));
    await fs.writeFile(path.join(dir, "index.html"), "<html>static index</html>");
    await fs.writeFile(path.join(dir, "app.js"), "console.log(1);");
    const { runtime } = makeRuntime();
    server = createServer({ runtime, clientDir: dir, logger: silentLogger });
    await server.listen(0);
    return `http://localhost:${server.port}`;
  }

  test("serves index.html at / with the right mime type", async () => {
    const base = await listenWithClientDir();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toBe("<html>static index</html>");
  });

  test("serves assets by extension mime type", async () => {
    const base = await listenWithClientDir();
    const res = await fetch(`${base}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("javascript");
  });

  test("falls through to 404 for files outside the client dir", async () => {
    const base = await listenWithClientDir();
    // Encoded traversal is not resolved into the parent directory.
    const res = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(404);
  });

  test("falls through to 404 for missing files", async () => {
    const base = await listenWithClientDir();
    const res = await fetch(`${base}/nope.js`);
    expect(res.status).toBe(404);
  });
});
