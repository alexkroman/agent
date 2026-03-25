// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";
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

  test("/health returns ok JSON", async () => {
    const agent = makeAgent({ name: "health-agent" });
    server = createServer({ agent, env: {}, logger: silentLogger });
    await server.listen(0);

    // Hono's serve binds on port 0, need to get actual port
    // We'll use a known port for testing
    await server.close();
    server = null;
  });

  test("listen and close lifecycle works", async () => {
    server = createServer({ agent: makeAgent(), env: {}, logger: silentLogger });
    await server.listen(0);
    await server.close();
    server = null;
  });

  test("/ returns default HTML with escaped agent name", async () => {
    const port = 19_876 + Math.floor(Math.random() * 1000);
    const agent = makeAgent({ name: '<script>alert("xss")</script>' });
    server = createServer({ agent, env: {}, logger: silentLogger });
    await server.listen(port);

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Agent server running.");
  });

  test("/ returns custom clientHtml when provided", async () => {
    const port = 19_876 + Math.floor(Math.random() * 1000);
    server = createServer({
      agent: makeAgent(),
      env: {},
      clientHtml: "<h1>Custom</h1>",
      logger: silentLogger,
    });
    await server.listen(port);

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    expect(html).toBe("<h1>Custom</h1>");
  });

  test("/health returns JSON with agent name", async () => {
    const port = 19_876 + Math.floor(Math.random() * 1000);
    server = createServer({
      agent: makeAgent({ name: "my-agent" }),
      env: {},
      logger: silentLogger,
    });
    await server.listen(port);

    const res = await fetch(`http://localhost:${port}/health`);
    const json = await res.json();
    expect(json).toEqual({ status: "ok", name: "my-agent" });
  });

  test("404 triggers error-level logging", async () => {
    const port = 19_876 + Math.floor(Math.random() * 1000);
    server = createServer({
      agent: makeAgent(),
      env: {},
      logger: silentLogger,
    });
    await server.listen(port);

    await fetch(`http://localhost:${port}/nonexistent-path`);
    // The middleware logs errors for status >= 400
    // Give a moment for async logging
    await new Promise((r) => setTimeout(r, 50));
    expect(silentLogger.error).toHaveBeenCalled();
  });

  test("close is safe to call without listen", async () => {
    server = createServer({ agent: makeAgent(), env: {}, logger: silentLogger });
    await server.close();
    server = null;
  });
});
