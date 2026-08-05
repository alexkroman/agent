// Copyright 2026 the AAI authors. MIT license.
/**
 * Shutdown must END long-lived responses, not have `process.exit` destroy
 * them mid-body.
 *
 * The assertion that matters is at the WIRE level: a chunked response cut off
 * before its terminating `0\r\n\r\n` is what Modal's ASGI proxy reports as
 * `TransferEncodingError: Not enough data to satisfy transfer length header`.
 * Asserting "the handler resolved" would pass with the bug present, so these
 * read raw bytes off a socket the way that proxy's parser does.
 */

import net from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { afterEach, describe, expect, test } from "vitest";
import { endLiveStreams, liveStreamCount, registerLiveStream } from "./live-streams.ts";

afterEach(() => {
  endLiveStreams();
});

describe("registry", () => {
  test("ends every registered stream and reports the count", () => {
    const ended: string[] = [];
    registerLiveStream(() => ended.push("a"));
    registerLiveStream(() => ended.push("b"));
    expect(endLiveStreams()).toBe(2);
    expect(ended).toEqual(["a", "b"]);
    // Drained, so a second shutdown pass ends nothing twice.
    expect(endLiveStreams()).toBe(0);
  });

  test("a stream that ended on its own deregisters", () => {
    const unregister = registerLiveStream(() => {
      throw new Error("must not run for a settled stream");
    });
    unregister();
    expect(liveStreamCount()).toBe(0);
    expect(endLiveStreams()).toBe(0);
  });

  test("one ender that throws does not strand the others", () => {
    let reached = false;
    registerLiveStream(() => {
      throw new Error("boom");
    });
    registerLiveStream(() => {
      reached = true;
    });
    expect(endLiveStreams()).toBe(2);
    expect(reached).toBe(true);
  });
});

/** Read a raw HTTP response, optionally hanging up after `hangUpAfterMs`. */
function rawGet(port: number, path: string): { done: Promise<string> } {
  const chunks: Buffer[] = [];
  const done = new Promise<string>((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    sock.on("data", (d: Buffer) => chunks.push(d));
    const finish = () => resolve(Buffer.concat(chunks).toString("latin1"));
    sock.on("close", finish);
    sock.on("error", finish);
  });
  return { done };
}

describe("an SSE response ended by shutdown", () => {
  test("terminates its chunked body instead of being cut mid-frame", async () => {
    const app = new Hono();
    // The studio's shape: hold open until something ends the stream, exactly
    // as createSsePusher's `wait` does.
    app.get("/events", (c) =>
      streamSSE(c, async (stream) => {
        const held = Promise.withResolvers<void>();
        const unregister = registerLiveStream(() => held.resolve());
        stream.onAbort(() => held.resolve());
        await stream.writeSSE({ event: "project", data: '{"a":1}' });
        try {
          await held.promise;
        } finally {
          unregister();
        }
      }),
    );

    const server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as net.AddressInfo;

    const res = rawGet(port, "/events");
    // Let the first frame land, then shut down as SIGTERM would.
    await new Promise((r) => setTimeout(r, 150));
    expect(liveStreamCount()).toBe(1);
    endLiveStreams();

    const raw = await res.done;
    expect(raw).toMatch(/transfer-encoding: chunked/i);
    expect(raw).toContain("event: project");
    // The whole point: the terminating zero-length chunk went out.
    expect(raw.endsWith("0\r\n\r\n")).toBe(true);
    // And the stream deregistered as it settled.
    expect(liveStreamCount()).toBe(0);

    await new Promise((r) => server.close(r));
  });
});
