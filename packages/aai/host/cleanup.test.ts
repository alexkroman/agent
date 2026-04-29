// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeMockCore, silentLogger } from "./_test-utils.ts";
import type { SessionCore } from "./session-core.ts";
import { wireSessionSocket } from "./ws-handler.ts";

const defaultConfig = { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 };

function makeOpenWs(): MockWebSocket {
  const ws = new MockWebSocket("ws://test");
  ws.readyState = MockWebSocket.OPEN;
  return ws;
}

function wire(
  ws: MockWebSocket,
  core: SessionCore,
  sessions: Map<string, SessionCore> = new Map(),
): Map<string, SessionCore> {
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

    ws.simulateMessage(new ArrayBuffer(4));

    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });

    ws.simulateMessage(new ArrayBuffer(4));
  });

  test("multiple rapid closes don't double-invoke stop()", async () => {
    const core = makeMockCore({
      stop: vi.fn(() => new Promise<void>((r) => setTimeout(r, 50))),
    });
    const ws = makeOpenWs();
    wire(ws, core);

    ws.close();

    await vi.waitFor(() => {
      expect(core.stop).toHaveBeenCalledOnce();
    });
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
