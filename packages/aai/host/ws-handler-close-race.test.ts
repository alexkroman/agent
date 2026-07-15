// Copyright 2026 the AAI authors. MIT license.
// Races between the WebSocket closing and session.start() settling.
// (Lives outside ws-handler.test.ts, which is at its file-length ceiling.)

import { describe, expect, test, vi } from "vitest";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeMockCore, silentLogger } from "./_test-utils.ts";
import type { SessionCore } from "./session-core.ts";
import { wireSessionSocket } from "./ws-handler.ts";

const defaultConfig = { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 };

function openSocket(): MockWebSocket {
  const ws = new MockWebSocket("ws://test");
  ws.readyState = MockWebSocket.OPEN;
  return ws;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("wireSessionSocket — close during start()", () => {
  test("buffered frames are not dispatched into the stopped session when start() later resolves", async () => {
    const startGate = deferred();
    const core = makeMockCore({ start: vi.fn(() => startGate.promise) });
    const ws = openSocket();
    const sessions = new Map<string, SessionCore>();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Client streams audio while start() is still in flight — buffered.
    ws.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([1, 2, 3]) }));

    // Socket closes before start() settles; the session is stopped.
    ws.close();
    await vi.waitFor(() => expect(core.stop).toHaveBeenCalled());

    // start() finally resolves — the buffer must not drain into the stopped
    // session, and it must not be marked ready.
    startGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(core.onAudio).not.toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });

  test("session cleanup runs exactly once when close precedes a start() failure", async () => {
    const startGate = deferred();
    const core = makeMockCore({ start: vi.fn(() => startGate.promise) });
    const ws = openSocket();
    const onSessionEnd = vi.fn();

    wireSessionSocket(ws, {
      sessions: new Map<string, SessionCore>(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
      onSessionEnd,
    });

    ws.close();
    await vi.waitFor(() => expect(core.stop).toHaveBeenCalled());

    startGate.reject(new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(core.stop).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  test("frames arriving after close are dropped", async () => {
    const core = makeMockCore();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map<string, SessionCore>(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });
    await vi.waitFor(() => expect(core.start).toHaveBeenCalled());

    ws.close();
    ws.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([9]) }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(core.onAudio).not.toHaveBeenCalled();
  });
});
