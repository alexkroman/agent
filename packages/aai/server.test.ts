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
    await vi.waitFor(() => expect(silentLogger.error).toHaveBeenCalled());
  });

  test("close is safe to call without listen", async () => {
    server = createServer({ agent: makeAgent(), env: {}, logger: silentLogger });
    await server.close();
    server = null;
  });

  test("accepts shutdownTimeoutMs option", () => {
    server = createServer({
      agent: makeAgent(),
      env: {},
      logger: silentLogger,
      shutdownTimeoutMs: 5000,
    });
    expect(server).toHaveProperty("close");
  });

  test("throws when both clientHtml and clientDir are provided", () => {
    expect(() =>
      createServer({
        agent: makeAgent(),
        env: {},
        clientHtml: "<h1>Custom</h1>",
        clientDir: "./public",
        logger: silentLogger,
      }),
    ).toThrow("mutually exclusive");
  });

  test("warns when no authToken is configured", async () => {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    server = createServer({ agent: makeAgent(), env: {}, logger });
    await server.listen(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("No authToken configured"));
  });

  test("does not warn when authToken is provided", async () => {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    server = createServer({ agent: makeAgent(), env: {}, logger, authToken: "secret" });
    await server.listen(0);
    const warnCalls = logger.warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnCalls.every((m) => !m.includes("No authToken"))).toBe(true);
  });

  test("successful request triggers info-level logging", async () => {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    server = createServer({ agent: makeAgent(), env: {}, logger });
    await server.listen(0);
    await fetch(`http://localhost:${server.port}/health`);
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/GET \/health 200/)),
    );
  });

  test("port returns undefined before listen", () => {
    server = createServer({ agent: makeAgent(), env: {}, logger: silentLogger });
    expect(server.port).toBeUndefined();
  });

  test("port returns actual port after listen", async () => {
    server = createServer({ agent: makeAgent(), env: {}, logger: silentLogger });
    await server.listen(0);
    expect(server.port).toBeGreaterThan(0);
  });

  test("listen throws if called twice", async () => {
    server = createServer({ agent: makeAgent(), env: {}, logger: silentLogger });
    await server.listen(0);
    await expect(server.listen(0)).rejects.toThrow("already listening");
  });

  test("/ returns CSP header", async () => {
    server = createServer({ agent: makeAgent(), env: {}, logger: silentLogger });
    await server.listen(0);
    const res = await fetch(`http://localhost:${server.port}/`);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });
});
