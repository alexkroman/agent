// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeAgent, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import { createServer } from "./server.ts";

/**
 * `fetch` + drain the body, always. Every request in this file goes through
 * it, so no test can reintroduce the leak below.
 *
 * An UNREAD response body holds its socket open, and Node counts such a
 * connection as active — so the `afterEach` `server.close()` waits it out
 * rather than closing. Against Node's own fetch that is a flat ~3s (undici
 * parks the socket for its 4s keep-alive minus a 1s threshold), which vitest
 * charges to whichever test it happens to be timing; under full-suite load
 * that intermittently blew this file's 5s default budget, on a test that had
 * done nothing slow. IDLE keep-alive sockets are `server.close()`'s own
 * problem and it now drops them, but a response nobody read is deliberately
 * not idle — truncating one would be a bug — so it has to be fixed here.
 *
 * Returning plain values rather than the `Response` is what makes it
 * airtight: there is no undrained body left to forget, and no way to consume
 * one twice.
 */
async function get(url: string): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(url);
  return { status: res.status, headers: res.headers, body: await res.text() };
}

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

  /**
   * `close()` drops idle keep-alive connections so shutdown doesn't wait out
   * a parked socket's timer. This is the other half of that bargain, and the
   * half that would be a real bug: a request still being served must finish.
   * `closeIdleConnections()` guarantees it where `closeAllConnections()` would
   * truncate the reply mid-body, so this test is what stops the two being
   * swapped.
   */
  test("close lets an in-flight request finish rather than truncating it", async () => {
    const { runtime } = makeRuntime();
    let began: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    server = createServer({
      runtime,
      logger: silentLogger,
      // A handler that has sent headers but not the body when close() lands.
      request: (_req, res, url) => {
        if (url !== "/slow") return false;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("first-half-");
        began?.();
        setTimeout(() => res.end("second-half"), 50);
        return true;
      },
    });
    await server.listen(0);

    const inFlight = get(`http://localhost:${server.port}/slow`);
    await started;
    await server.close();
    server = null;
    expect((await inFlight).body).toBe("first-half-second-half");
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

    const { body: html } = await get(`http://localhost:${server.port}/`);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Agent server running.");
  });

  test("/health returns JSON with agent name", async () => {
    const { runtime } = makeRuntime({ name: "my-agent" });
    server = createServer({ runtime, name: "my-agent", logger: silentLogger });
    await server.listen(0);

    const { body } = await get(`http://localhost:${server.port}/health`);
    expect(JSON.parse(body)).toEqual({ status: "ok", name: "my-agent" });
  });

  test("404 triggers error-level logging", async () => {
    const { runtime } = makeRuntime();
    server = createServer({ runtime, logger: silentLogger });
    await server.listen(0);

    await get(`http://localhost:${server.port}/nonexistent-path`);
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

    const { headers } = await get(`http://localhost:${server.port}/health`);
    expect(headers.get("Content-Security-Policy")).toBeTruthy();
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  test("GET /client-config defaults to the agent kind", async () => {
    const { runtime } = makeRuntime({ name: "cfg-agent" });
    server = createServer({ runtime, name: "cfg-agent", logger: silentLogger });
    await server.listen(0);

    const { status, body } = await get(`http://localhost:${server.port}/client-config`);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ name: "cfg-agent" });
  });

  test("GET /client-config carries the declared greeting", async () => {
    const { runtime } = makeRuntime({ name: "wf-agent" });
    server = createServer({
      runtime,
      name: "wf-agent",
      greeting: "Hi there!",
      logger: silentLogger,
    });
    await server.listen(0);

    const { status, body } = await get(`http://localhost:${server.port}/client-config`);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      name: "wf-agent",
      greeting: "Hi there!",
    });
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
    const { status, headers, body } = await get(`${base}/`);
    expect(status).toBe(200);
    expect(headers.get("Content-Type")).toContain("text/html");
    expect(body).toBe("<html>static index</html>");
  });

  test("serves assets by extension mime type", async () => {
    const base = await listenWithClientDir();
    const { status, headers } = await get(`${base}/app.js`);
    expect(status).toBe(200);
    expect(headers.get("Content-Type")).toContain("javascript");
  });

  test("falls through to 404 for files outside the client dir", async () => {
    const base = await listenWithClientDir();
    // Encoded traversal is not resolved into the parent directory.
    expect((await get(`${base}/..%2f..%2fetc%2fpasswd`)).status).toBe(404);
  });

  test("serves assets whose names need percent-decoding", async () => {
    const base = await listenWithClientDir();
    if (!dir) throw new Error("client dir missing");
    await fs.writeFile(path.join(dir, "my asset.js"), "console.log(2);");
    const { status, body } = await get(`${base}/my%20asset.js`);
    expect(status).toBe(200);
    expect(body).toBe("console.log(2);");
  });

  test("fully-encoded traversal (%2e%2e%2f) still 404s after decoding", async () => {
    const base = await listenWithClientDir();
    expect((await get(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).status).toBe(404);
  });

  test("a malformed percent escape yields 404, not a crash", async () => {
    const base = await listenWithClientDir();
    expect((await get(`${base}/%zz.js`)).status).toBe(404);
  });

  test("falls through to 404 for missing files", async () => {
    const base = await listenWithClientDir();
    expect((await get(`${base}/nope.js`)).status).toBe(404);
  });

  test("a client asset can never shadow GET /client-config", async () => {
    const base = await listenWithClientDir();
    if (!dir) throw new Error("client dir missing");
    await fs.writeFile(path.join(dir, "client-config"), "not the endpoint");
    const { headers, body } = await get(`${base}/client-config`);
    expect(headers.get("Content-Type")).toContain("application/json");
    expect((JSON.parse(body) as { name?: string }).name).toBeDefined();
  });
});
