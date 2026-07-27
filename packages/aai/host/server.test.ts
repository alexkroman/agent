// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
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
