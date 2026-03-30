// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeAgent } from "./_test-utils.ts";
import { createRuntime } from "./direct-executor.ts";
import { createServer } from "./server.ts";

const silentLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

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
    await server.close();
    server = null;
  });

  test("listen and close lifecycle works", async () => {
    const { runtime } = makeRuntime();
    server = createServer({ runtime, logger: silentLogger });
    await server.listen(0);
    await server.close();
    server = null;
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
    server = createServer({
      runtime,
      name: "my-agent",
      logger: silentLogger,
    });
    await server.listen(0);

    const res = await fetch(`http://localhost:${server.port}/health`);
    const json = await res.json();
    expect(json).toEqual({ status: "ok", name: "my-agent" });
  });

  test("404 triggers error-level logging", async () => {
    const { runtime } = makeRuntime();
    server = createServer({
      runtime,
      logger: silentLogger,
    });
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
});
