// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionEventBody } from "@alexkroman1/aai/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { makeAgent, makeLogger, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import { createRuntimeServer, type SessionRuntime } from "./server.ts";

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

function makeRuntime(opts: { name?: string } = {}) {
  const agent = makeAgent(opts.name ? { name: opts.name } : {});
  return {
    agent,
    runtime: createRuntime({ agent, env: {}, logger: silentLogger }),
  };
}

describe("createRuntimeServer", () => {
  let server: ReturnType<typeof createRuntimeServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  test("returns an object with listen and close", () => {
    const { runtime } = makeRuntime();
    server = createRuntimeServer({ runtime, logger: silentLogger });
    expect(server).toHaveProperty("listen");
    expect(server).toHaveProperty("close");
  });

  /**
   * Both halves of what `close()` has to do at once, in the scenario that
   * forced the design: a request is mid-response when close() lands, and the
   * socket goes IDLE a moment later.
   *
   * - The reply must arrive complete. `closeIdleConnections()` guarantees that
   *   where `closeAllConnections()` would truncate it mid-body, so the first
   *   assertion is what stops those two being swapped.
   * - Shutdown must not then wait out the newly-idle socket's keep-alive
   *   timer. That is why the drop SWEEPS: a single call fires while the
   *   request is still active, finds nothing to do, and the connection parks
   *   for a flat ~3s (Node's fetch: undici's 4s keep-alive minus its 1s
   *   threshold) or up to 5s (a browser). `aai dev` pays it on every watch
   *   restart, and no assertion about BEHAVIOUR can see it — the server shuts
   *   down correctly either way, just slowly.
   *
   * The two pull against each other, which is the point: passing both is only
   * possible by dropping idle connections repeatedly, and each assertion fails
   * on a different way of getting it wrong (verified by mutation). The bound is
   * deliberately loose — ~100ms passing, ~3s regressed — so it discriminates
   * the mechanism, not the machine.
   */
  test("close finishes an in-flight request, then exits without waiting on it", async () => {
    const { runtime } = makeRuntime();
    const started = Promise.withResolvers<void>();
    server = createRuntimeServer({
      runtime,
      logger: silentLogger,
      // A handler that has sent headers but not the body when close() lands.
      request: (_req, res, url) => {
        if (url !== "/slow") return false;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("first-half-");
        started.resolve();
        setTimeout(() => res.end("second-half"), 50);
        return true;
      },
    });
    await server.listen(0);

    const inFlight = get(`http://localhost:${server.port}/slow`);
    await started.promise;
    const closeBegan = Date.now();
    await server.close();
    const closeMs = Date.now() - closeBegan;
    server = null;

    expect((await inFlight).body).toBe("first-half-second-half");
    expect(closeMs).toBeLessThan(1500);
  });

  test("listen assigns an ephemeral port and close releases it", async () => {
    const { runtime } = makeRuntime();
    server = createRuntimeServer({ runtime, logger: silentLogger });
    await server.listen(0);

    // `listen(0)` means "pick a free port", so the assignment is the only
    // evidence the server is really bound.
    const { port } = server;
    expect(port).toBeGreaterThan(0);
    expect((await get(`http://localhost:${port}/health`)).status).toBe(200);

    await server.close();
    server = null;
    // Closed for real: the port is free to bind again.
    const second = createRuntimeServer({ runtime, logger: silentLogger });
    await expect(second.listen(port)).resolves.toBeUndefined();
    await second.close();
  });

  test("/ returns default HTML with escaped agent name", async () => {
    const name = '<script>alert("xss")</script>';
    const { runtime } = makeRuntime({ name });
    server = createRuntimeServer({ runtime, name, logger: silentLogger });
    await server.listen(0);

    const { body: html } = await get(`http://localhost:${server.port}/`);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Agent server running.");
  });

  test("/health returns JSON with agent name", async () => {
    const { runtime } = makeRuntime({ name: "my-agent" });
    server = createRuntimeServer({ runtime, name: "my-agent", logger: silentLogger });
    await server.listen(0);

    const { body } = await get(`http://localhost:${server.port}/health`);
    expect(JSON.parse(body)).toEqual({ status: "ok", name: "my-agent" });
  });

  test("404 triggers error-level logging", async () => {
    // A FRESH logger: `silentLogger` is a shared singleton whose `vi.fn()`
    // call history accumulates across every test in the file (`restoreMocks`
    // restores spies, not mock call logs). A bare `toHaveBeenCalled()` against
    // it passes on an error some earlier test logged — which is exactly what
    // this assertion was doing, and why `makeLogger()` exists.
    const logger = makeLogger();
    const { runtime } = makeRuntime();
    server = createRuntimeServer({ runtime, logger });
    await server.listen(0);

    expect(logger.error).not.toHaveBeenCalled();
    await get(`http://localhost:${server.port}/nonexistent-path`);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
  });

  test("close is safe to call without listen", async () => {
    const { runtime } = makeRuntime();
    server = createRuntimeServer({ runtime, logger: silentLogger });
    // Stated, not merely survived: SIGINT before the listen resolves must not
    // reject, and the `afterEach` calling close again must not either.
    await expect(server.close()).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    server = null;
  });

  // A case called "accepts shutdownTimeoutMs in runtime options" stood here and
  // asserted `expect(server).toHaveProperty("close")` — nothing about the
  // option, which is `createRuntime`'s and not this server's. What the deadline
  // actually does is asserted in `runtime-lifecycle.test.ts`.

  test("responses carry security headers", async () => {
    const { runtime } = makeRuntime();
    server = createRuntimeServer({ runtime, logger: silentLogger });
    await server.listen(0);

    const { headers } = await get(`http://localhost:${server.port}/health`);
    expect(headers.get("Content-Security-Policy")).toBeTruthy();
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  // The directive above is asserted only for PRESENCE, which is what let a
  // workflow app ship with its player broken: an upload's bytes reach an
  // `<audio>` as a `blob:` object URL (the byte route wants an `Authorization`
  // header no `src` can send), and with no `media-src` that falls back to
  // `default-src 'self'`, which a blob URL is not. `<a download>` on the SAME
  // url kept working, so the page looked half-fine. `data:` is the caption
  // `<track>`, which CSP governs with this directive too.
  test("the CSP lets a page play a blob: object URL", async () => {
    const { runtime } = makeRuntime();
    server = createRuntimeServer({ runtime, logger: silentLogger });
    await server.listen(0);

    const { headers } = await get(`http://localhost:${server.port}/health`);
    const media = (headers.get("Content-Security-Policy") ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("media-src"));
    expect(media).toBeDefined();
    expect(media).toContain("blob:");
    expect(media).toContain("data:");
  });

  test("GET /client-config defaults to the agent kind", async () => {
    const { runtime } = makeRuntime({ name: "cfg-agent" });
    server = createRuntimeServer({ runtime, name: "cfg-agent", logger: silentLogger });
    await server.listen(0);

    const { status, body } = await get(`http://localhost:${server.port}/client-config`);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ name: "cfg-agent", page: "voice" });
  });

  test("GET /client-config carries the declared greeting", async () => {
    const { runtime } = makeRuntime({ name: "wf-agent" });
    server = createRuntimeServer({
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
      page: "voice",
    });
  });
});

describe("createRuntimeServer static client dir", () => {
  let server: ReturnType<typeof createRuntimeServer> | null = null;
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
    server = createRuntimeServer({ runtime, clientDir: dir, logger: silentLogger });
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

/**
 * The `/phone` route end to end: a real HTTP upgrade, the real bridge, and a
 * carrier speaking Twilio's framing on the far end.
 *
 * The runtime here is a stub rather than a real one because the property
 * under test is the WIRING — that a carrier's socket reaches a session as an
 * ordinary `SessionWebSocket`, and that audio crosses in both directions. A
 * real runtime would need provider credentials to produce a single byte of
 * TTS, which is the one thing this route does not touch.
 */
describe("createRuntimeServer telephony route", () => {
  let server: ReturnType<typeof createRuntimeServer> | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  /** A runtime that echoes one 20 ms chunk of 24 kHz TTS back per inbound frame. */
  /**
   * A runtime that echoes, and the frame it opens with is the point.
   *
   * `session.configured` is what `session-core.ts` emits. This fake sent
   * `{ type: "config" }` — a client-to-SERVER host-mode shape no session
   * produces — and so did the bridge's own spec, which is how "carries a call in
   * both directions" passed while a real call carried nothing in either: the
   * bridge configured its resamplers on a frame that never arrived, then dropped
   * the agent's audio as "before the config frame" and the caller's silently.
   *
   * Typed as `SessionEventBody` so the next rename is a compile error here
   * rather than a green suite over a dead integration.
   */
  function echoRuntime(received: unknown[]): SessionRuntime {
    const configured: SessionEventBody = {
      type: "session.configured",
      audioFormat: "pcm16",
      sampleRate: 16_000,
      ttsSampleRate: 24_000,
      sessionId: "sess_test",
    };
    return {
      startSession(ws) {
        ws.send(JSON.stringify(configured));
        ws.addEventListener("message", (event: { data: unknown }) => {
          received.push(event.data);
          if (event.data instanceof Uint8Array) ws.send(new Uint8Array(480 * 2));
        });
      },
      shutdown: () => Promise.resolve(),
    };
  }

  async function openCarrier(url: string): Promise<WebSocket> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return socket;
  }

  /** The `ws` error for an upgrade the server refused before the handshake. */
  function refusal(url: string): Promise<Error> {
    return new Promise<Error>((resolve) => new WebSocket(url).once("error", resolve));
  }

  test("carries a call in both directions", async () => {
    const received: unknown[] = [];
    server = createRuntimeServer({ runtime: echoRuntime(received), logger: silentLogger });
    await server.listen(0);

    const socket = await openCarrier(`ws://localhost:${server.port}/phone`);
    const fromCarrier: Record<string, unknown>[] = [];
    socket.on("message", (data: Buffer) => fromCarrier.push(JSON.parse(data.toString())));

    socket.send(JSON.stringify({ event: "start", streamSid: "MZ1", start: {} }));
    socket.send(
      JSON.stringify({
        event: "media",
        streamSid: "MZ1",
        media: { payload: Buffer.alloc(160, 0xff).toString("base64") },
      }),
    );

    // The synthesized audio_ready, then the caller's audio as PCM16.
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2));
    expect(received[0]).toBe(JSON.stringify({ type: "audio_ready" }));
    expect(received[1]).toBeInstanceOf(Uint8Array);

    // And the reply comes back as a Twilio media frame.
    await vi.waitFor(() => expect(fromCarrier.length).toBeGreaterThanOrEqual(1));
    expect(fromCarrier[0]).toMatchObject({ event: "media", streamSid: "MZ1" });
    socket.close();
  });

  test("refuses an unknown carrier without upgrading", async () => {
    server = createRuntimeServer({ runtime: echoRuntime([]), logger: silentLogger });
    await server.listen(0);

    const err = await refusal(`ws://localhost:${server.port}/phone?carrier=vonage`);
    expect(err.message).toContain("400");
  });

  test("telephony: false removes the route", async () => {
    server = createRuntimeServer({
      runtime: echoRuntime([]),
      logger: silentLogger,
      telephony: false,
    });
    await server.listen(0);

    const err = await refusal(`ws://localhost:${server.port}/phone`);
    expect(err.message).toContain("404");
  });
});
