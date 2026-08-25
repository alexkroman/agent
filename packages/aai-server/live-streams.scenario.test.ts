// Copyright 2026 the AAI authors. MIT license.
/**
 * Shutdown must END long-lived responses at the WIRE level, not have
 * `process.exit` destroy them mid-body.
 *
 * A chunked response cut off before its terminating `0\r\n\r\n` is what Modal's
 * ASGI proxy reports as `TransferEncodingError: Not enough data to satisfy
 * transfer length header`. Asserting "the handler resolved" would pass with the
 * bug present, so these read raw bytes off a socket the way that proxy's parser
 * does.
 *
 * SCENARIO tier because of that: these two bind a real TCP port and speak HTTP
 * over it, which is exactly the membership rule (AGENTS.md, "Test tiers") — the
 * unit tier is "no filesystem writes, subprocess, or real network". The
 * registry's own semantics stay in `live-streams.test.ts`, where they are pure
 * memory and keep the module inside the package's measured coverage.
 */

import net from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  endLiveStreams,
  liveStreamCount,
  registerLiveStream,
  resetLiveStreams,
} from "./live-streams.ts";

afterEach(() => {
  // Drops the shutdown latch too — without the reset, the first test to call
  // endLiveStreams() would leave every later one registering into a closed
  // registry.
  resetLiveStreams();
});

/** The terminating zero-length chunk that ends a `chunked` body. */
const CHUNKED_TERMINATOR = "0\r\n\r\n";

/**
 * Read a raw HTTP response off a socket, the way Modal's ASGI proxy parser
 * does.
 *
 * Resolves as soon as the chunked body is COMPLETE — i.e. the terminating
 * `0\r\n\r\n` has arrived — and then hangs up. It used to resolve on the
 * socket's `close` event instead, which is the same bytes but ~6s later per
 * call: the body (terminator included) is fully on the wire within ~150ms,
 * and the rest was spent waiting out the node-server connection timeout that
 * no assertion here depends on. That was 12s of the suite's wall clock across
 * these two tests.
 *
 * `error`/`close` still settle it so a genuinely truncated body fails the
 * `endsWith` assertion rather than hanging until the test timeout.
 */
function rawGet(port: number, path: string): { done: Promise<string> } {
  const chunks: Buffer[] = [];
  const done = new Promise<string>((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    const settle = () => resolve(Buffer.concat(chunks).toString("latin1"));
    sock.on("data", (d: Buffer) => {
      chunks.push(d);
      // Check the accumulated buffer, not the chunk: the terminator can be
      // split across TCP segments.
      if (Buffer.concat(chunks).toString("latin1").endsWith(CHUNKED_TERMINATOR)) {
        settle();
        sock.destroy();
      }
    });
    sock.on("close", settle);
    sock.on("error", settle);
  });
  return { done };
}

/**
 * A marker every response from THIS server carries.
 *
 * These tests take an ephemeral port (`port: 0`) and then read raw bytes off a
 * socket, so they will happily assert against whatever answers. That produced
 * one genuinely baffling CI failure: `expected 'HTTP/1.1 200 OK…' to match
 * /transfer-encoding: chunked/`, on a 6293-byte `text/html` body whose title
 * was **Ollama** — the desktop app, which listens on a random port in the same
 * ephemeral range this asks the OS for.
 *
 * The exact path was never reproduced (binding a port another process holds is
 * EADDRINUSE, and `port: 0` allocates sequentially away from it), which is
 * precisely why the marker is here rather than a fix for a mechanism nobody
 * pinned down: a foreign responder now fails by NAME instead of as a confusing
 * claim about transfer encoding.
 */
const SERVER_MARKER = "x-live-streams-scenario";

/**
 * Serve the studio's SSE shape — hold open until something ends the stream,
 * exactly as createSsePusher's `wait` does — on an ephemeral port.
 */
async function serveHeldSse(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = new Hono();
  app.get("/events", (c) => {
    c.header(SERVER_MARKER, "1");
    return streamSSE(c, async (stream) => {
      const held = Promise.withResolvers<void>();
      const unregister = registerLiveStream(() => held.resolve());
      stream.onAbort(() => held.resolve());
      await stream.writeSSE({ event: "project", data: '{"a":1}' });
      try {
        await held.promise;
      } finally {
        unregister();
      }
    });
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as net.AddressInfo;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("an SSE response ended by shutdown", () => {
  test("terminates its chunked body instead of being cut mid-frame", async () => {
    const { port, close } = await serveHeldSse();

    const res = rawGet(port, "/events");
    // Wait for the handler to register, then shut down as SIGTERM would. The
    // first frame is written before the handler awaits its held promise, so
    // registration is the only thing worth waiting on here.
    await vi.waitFor(() => expect(liveStreamCount()).toBe(1));
    endLiveStreams();

    const raw = await res.done;
    // Provenance first: see SERVER_MARKER. Without this, a foreign listener on
    // this port fails as an inscrutable transfer-encoding mismatch.
    expect(raw, "response did not come from this test's server").toContain(SERVER_MARKER);
    expect(raw).toMatch(/transfer-encoding: chunked/i);
    expect(raw).toContain("event: project");
    // The whole point: the terminating zero-length chunk went out.
    expect(raw.endsWith(CHUNKED_TERMINATOR)).toBe(true);
    // And the stream deregistered as it settled.
    expect(liveStreamCount()).toBe(0);

    await close();
  });

  test("a stream opened DURING shutdown also terminates its body", async () => {
    const { port, close } = await serveHeldSse();
    // Shutdown has already drained the registry; the client's 3s reconnect
    // lands inside the grace window while this replica is still serving.
    endLiveStreams();

    const raw = await rawGet(port, "/events").done;
    expect(raw, "response did not come from this test's server").toContain(SERVER_MARKER);
    expect(raw).toMatch(/transfer-encoding: chunked/i);
    expect(raw.endsWith(CHUNKED_TERMINATOR)).toBe(true);
    // Held open instead, it would have been cut by the process exit.
    expect(liveStreamCount()).toBe(0);

    await close();
  });
});
