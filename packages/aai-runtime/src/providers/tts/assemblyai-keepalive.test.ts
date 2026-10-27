// Copyright 2026 the AAI authors. MIT license.
// AssemblyAI TTS KeepAlive specs. The service closes a socket that has
// received nothing for 120 s (`3006`), and the pipeline treats that close as
// fatal, so the adapter keeps a quiet socket alive itself.

import { TTS_KEEPALIVE_INTERVAL_MS } from "@alexkroman1/aai/host-internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openSession } from "./_assemblyai-session-test-utils.ts";
import { FakeWebSocket } from "./_fake-ws-test-utils.ts";

const SERVICE_IDLE_CLOSE_MS = 120_000;

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const keepAlives = (ws: FakeWebSocket) =>
  ws._frames().filter((frame) => frame.type === "KeepAlive").length;

describe("AssemblyAI TTS KeepAlive", () => {
  test("the interval leaves margin inside the service's idle window", () => {
    // Worst case: the last frame lands just after a timer tick, so the next
    // KeepAlive is almost two intervals later.
    expect(2 * TTS_KEEPALIVE_INTERVAL_MS).toBeLessThan(SERVICE_IDLE_CLOSE_MS);
  });

  test("a quiet socket is sent a KeepAlive", async () => {
    const { ws } = await openSession();
    await vi.advanceTimersByTimeAsync(TTS_KEEPALIVE_INTERVAL_MS);
    expect(keepAlives(ws)).toBe(1);
  });

  test("no frame gap ever reaches the service's idle window", async () => {
    const { ws } = await openSession();
    await vi.advanceTimersByTimeAsync(5 * SERVICE_IDLE_CLOSE_MS);
    expect(keepAlives(ws)).toBeGreaterThanOrEqual(
      (5 * SERVICE_IDLE_CLOSE_MS) / (2 * TTS_KEEPALIVE_INTERVAL_MS),
    );
  });

  test("a socket that is speaking is not sent one", async () => {
    const { session, ws } = await openSession();
    await vi.advanceTimersByTimeAsync(TTS_KEEPALIVE_INTERVAL_MS - 1000);
    session.sendText("Your order has shipped. ");
    await vi.advanceTimersByTimeAsync(1000);
    expect(keepAlives(ws)).toBe(0);
  });

  test("a closed session sends nothing more", async () => {
    const { session, ws } = await openSession();
    await session.close();
    const sentAtClose = ws.sent.length;
    await vi.advanceTimersByTimeAsync(5 * TTS_KEEPALIVE_INTERVAL_MS);
    expect(ws.sent.length).toBe(sentAtClose);
  });
});
