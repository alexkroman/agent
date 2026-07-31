// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the shared guest-harness wiring: stdio draining (log cap
 * included) and the guest WebSocket dial against a real loopback server.
 * The WarmHarness lifecycle itself (exit fan-out, memoized cleanup) is
 * exercised through both backends' suites — modal-sandbox.test.ts and
 * apple-container-sandbox.test.ts.
 */

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { dialGuest, drainProcStream } from "./warm-harness.ts";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  });
}

describe("drainProcStream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs guest output under the label and skips blank chunks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await drainProcStream(streamOf(["boom at line 3\n", "   \n"]), "[container:x] stderr");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[container:x] stderr: boom at line 3");
  });

  it("stops logging past the byte cap but keeps draining to stream end", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const big = "x".repeat(64 * 1024); // one chunk exhausts the cap
    await expect(drainProcStream(streamOf([big, "after the cap"]), "[l]")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1); // the capped chunk only
  });

  it("swallows a stream that errors mid-read", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("peer died"));
      },
    });
    await expect(drainProcStream(stream, "[l]")).resolves.toBeUndefined();
  });
});

describe("dialGuest", () => {
  it("connects to a listening harness and presents the bearer token", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as AddressInfo).port;
    const authHeader = new Promise<string | undefined>((resolve) => {
      wss.once("connection", (_ws, req) => resolve(req.headers.authorization));
    });

    const ws = await dialGuest(`ws://127.0.0.1:${port}/ws`, "tok-123");
    try {
      await expect(authHeader).resolves.toBe("Bearer tok-123");
      expect(ws.readyState).toBe(ws.OPEN);
    } finally {
      ws.close();
      await new Promise((resolve) => wss.close(resolve));
    }
  });

  it("retries refused connections until the harness server comes up", async () => {
    // Reserve a port, dial it while nothing is listening, then bring the
    // server up mid-retry — the dial must recover, not fail fast.
    const probe = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => probe.once("listening", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));

    const pending = dialGuest(`ws://127.0.0.1:${port}/ws`, "tok");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const wss = new WebSocketServer({ host: "127.0.0.1", port });
    await new Promise((resolve) => wss.once("listening", resolve));

    const ws = await pending;
    try {
      expect(ws.readyState).toBe(ws.OPEN);
    } finally {
      ws.close();
      await new Promise((resolve) => wss.close(resolve));
    }
  });
});
