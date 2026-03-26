// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { makeAgent } from "./_test-utils.ts";
import { createServer } from "./server.ts";

const silentLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

describe("createServer", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  test("returns an object with listen and close", () => {
    server = createServer({ agent: makeAgent(), env: {}, logger: silentLogger });
    expect(server).toHaveProperty("listen");
    expect(server).toHaveProperty("close");
  });

  test("listen and close lifecycle works", async () => {
    server = createServer({ agent: makeAgent(), env: {}, logger: silentLogger });
    await server.listen(0);
    await server.close();
    server = null;
  });

  test("/ returns default HTML with escaped agent name", async () => {
    const agent = makeAgent({ name: '<script>alert("xss")</script>' });
    server = createServer({ agent, env: {}, logger: silentLogger });
    await server.listen(0);

    const res = await fetch(`http://localhost:${server.port}/`);
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Agent server running.");
  });

  test("/ returns custom clientHtml when provided", async () => {
    server = createServer({
      agent: makeAgent(),
      env: {},
      clientHtml: "<h1>Custom</h1>",
      logger: silentLogger,
    });
    await server.listen(0);

    const res = await fetch(`http://localhost:${server.port}/`);
    const html = await res.text();
    expect(html).toBe("<h1>Custom</h1>");
  });

  test("/health returns JSON with agent name", async () => {
    server = createServer({
      agent: makeAgent({ name: "my-agent" }),
      env: {},
      logger: silentLogger,
    });
    await server.listen(0);

    const res = await fetch(`http://localhost:${server.port}/health`);
    const json = await res.json();
    expect(json).toEqual({ status: "ok", name: "my-agent" });
  });

  test("404 triggers error-level logging", async () => {
    server = createServer({
      agent: makeAgent(),
      env: {},
      logger: silentLogger,
    });
    await server.listen(0);

    await fetch(`http://localhost:${server.port}/nonexistent-path`);
    await vi.waitFor(() => {
      expect(silentLogger.error).toHaveBeenCalled();
    });
  });

  test("close is safe to call without listen", async () => {
    server = createServer({ agent: makeAgent(), env: {}, logger: silentLogger });
    await server.close();
    server = null;
  });
});

function connectWs(
  port: number,
  origin?: string,
): Promise<{ ws: WebSocket; error?: never } | { ws?: never; error: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: origin ? { origin } : {},
    });
    ws.on("open", () => resolve({ ws }));
    ws.on("error", (err) => resolve({ error: err.message }));
    ws.on("unexpected-response", (_req, res) => {
      resolve({ error: `HTTP ${res.statusCode}` });
    });
  });
}

function getPort(s: ReturnType<typeof createServer>): number {
  const p = s.port;
  if (p == null) throw new Error("server not listening");
  return p;
}

describe("WebSocket origin validation", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  test("rejects connections from disallowed origins by default", async () => {
    server = createServer({ agent: makeAgent(), logger: silentLogger, env: {} });
    await server.listen(0);

    const result = await connectWs(getPort(server), "http://evil.com");
    expect(result.error).toContain("403");
  });

  test("allows connections from localhost by default", async () => {
    server = createServer({ agent: makeAgent(), logger: silentLogger, env: {} });
    await server.listen(0);

    const port = getPort(server);
    const result = await connectWs(port, `http://localhost:${port}`);
    expect(result.ws).toBeDefined();
    result.ws?.close();
  });

  test("allows connections from 127.0.0.1 by default", async () => {
    server = createServer({ agent: makeAgent(), logger: silentLogger, env: {} });
    await server.listen(0);

    const port = getPort(server);
    const result = await connectWs(port, `http://127.0.0.1:${port}`);
    expect(result.ws).toBeDefined();
    result.ws?.close();
  });

  test("allows connections with no origin header (non-browser clients)", async () => {
    server = createServer({ agent: makeAgent(), logger: silentLogger, env: {} });
    await server.listen(0);

    const result = await connectWs(getPort(server));
    expect(result.ws).toBeDefined();
    result.ws?.close();
  });

  test("allows custom origins when configured", async () => {
    server = createServer({
      agent: makeAgent(),
      logger: silentLogger,
      env: {},
      allowedOrigins: ["https://myapp.example.com"],
    });
    await server.listen(0);

    const allowed = await connectWs(getPort(server), "https://myapp.example.com");
    expect(allowed.ws).toBeDefined();
    allowed.ws?.close();

    const rejected = await connectWs(getPort(server), "https://evil.com");
    expect(rejected.error).toContain("403");
  });

  test("allows any origin when set to '*'", async () => {
    server = createServer({
      agent: makeAgent(),
      logger: silentLogger,
      env: {},
      allowedOrigins: "*",
    });
    await server.listen(0);

    const result = await connectWs(getPort(server), "http://any-origin.com");
    expect(result.ws).toBeDefined();
    result.ws?.close();
  });
});
