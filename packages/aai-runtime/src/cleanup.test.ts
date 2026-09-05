// Copyright 2025 the AAI authors. MIT license.

import { createOwnedMap, type OwnedMap } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeMockCore, silentLogger, sleep } from "./_test-utils.ts";
import { simulateBinaryFrame } from "./_ws-handler-test-utils.ts";
import type { ServerSession } from "./session-core.ts";
import { wireSessionSocket } from "./ws-handler.ts";

const defaultConfig = { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 };

function makeOpenWs(): MockWebSocket {
  const ws = new MockWebSocket("ws://test");
  ws.readyState = MockWebSocket.OPEN;
  return ws;
}

function wire(
  ws: MockWebSocket,
  core: ServerSession,
  sessions: OwnedMap<string, ServerSession> = createOwnedMap(),
): OwnedMap<string, ServerSession> {
  wireSessionSocket(ws, {
    sessions,
    createSession: () => core,
    readyConfig: defaultConfig,
    logger: silentLogger,
  });
  return sessions;
}

describe("wireSessionSocket resource cleanup", () => {
  test("session.stop() is called exactly once on normal close", async () => {
    const core = makeMockCore();
    const ws = makeOpenWs();

    wire(ws, core);
    ws.close();

    await vi.waitFor(() => {
      expect(core.stop).toHaveBeenCalledOnce();
    });
  });

  test("session is removed from sessions map even when stop() rejects", async () => {
    const core = makeMockCore({ stop: vi.fn(() => Promise.reject(new Error("stop failed"))) });
    const ws = makeOpenWs();
    const sessions = wire(ws, core);

    expect(sessions.size).toBe(1);
    ws.close();

    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });
  });

  test("message buffer is cleared when start() fails", async () => {
    const core = makeMockCore({ start: vi.fn(() => Promise.reject(new Error("start failed"))) });
    const ws = makeOpenWs();
    const sessions = wire(ws, core);

    // Arrives while start() is still in flight, so it is BUFFERED rather than
    // dispatched — a `Uint8Array` because that is the one frame kind the
    // handler would forward to the core, which is what makes "the buffer was
    // dropped" observable at all.
    simulateBinaryFrame(ws, new Uint8Array([1, 2, 3, 4]));

    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });

    // A frame arriving after the failure has nowhere to go either.
    simulateBinaryFrame(ws, new Uint8Array([5, 6, 7, 8]));

    // The claimed behaviour: neither frame is ever replayed into a session that
    // failed to start. Without this the test only restated the case above it.
    expect(core.onAudio).not.toHaveBeenCalled();
  });

  test("multiple rapid closes don't double-invoke stop()", async () => {
    const core = makeMockCore({
      stop: vi.fn(() => sleep(50)),
    });
    const ws = makeOpenWs();
    wire(ws, core);

    // Three close events, the second and third landing while the first stop()
    // is still in flight (it takes 50 ms) — the guard has to hold DURING the
    // drain, and the single close this test used to send exercised none of it.
    ws.close();
    ws.close();
    ws.close();

    await vi.waitFor(() => {
      expect(core.stop).toHaveBeenCalledOnce();
    });

    // And after it: a late close on an already-ended session starts nothing.
    await sleep(60);
    ws.close();
    expect(core.stop).toHaveBeenCalledOnce();
  });

  test("close before open does not throw or leak", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.CONNECTING;
    const sessions = wire(ws, makeMockCore());

    ws.close();
    expect(sessions.size).toBe(0);
  });

  test("error event after close does not throw", async () => {
    const core = makeMockCore();
    const ws = makeOpenWs();
    wire(ws, core);

    ws.close();
    await vi.waitFor(() => {
      expect(core.stop).toHaveBeenCalled();
    });

    ws.dispatchEvent(new Event("error"));
  });
});
