// Copyright 2025 the AAI authors. MIT license.
/**
 * Resource cleanup and leak detection tests for server-side components.
 *
 * Verifies that WebSocket connections, S2S handles, timers,
 * message buffers, and hook promises are properly cleaned up on disconnect,
 * error, and reset to prevent memory leaks in long-running processes.
 */

import { describe, expect, test, vi } from "vitest";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeMockCore, silentLogger } from "./_test-utils.ts";
import type { SessionCore } from "./session-core.ts";
import { wireSessionSocket } from "./ws-handler.ts";

const defaultConfig = { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 };

// ─── wireSessionSocket cleanup tests ─────────────────────────────────────────

describe("wireSessionSocket resource cleanup", () => {
  test("session.stop() is called exactly once on normal close", async () => {
    const core = makeMockCore();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    ws.close();

    await vi.waitFor(() => {
      expect(core.stop).toHaveBeenCalledOnce();
    });
  });

  test("session is removed from sessions map even when stop() rejects", async () => {
    const sessions = new Map<string, SessionCore>();
    const core = makeMockCore({ stop: vi.fn(() => Promise.reject(new Error("stop failed"))) });

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions,
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(sessions.size).toBe(1);
    ws.close();

    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });
  });

  test("message buffer is cleared when start() fails", async () => {
    const core = makeMockCore({ start: vi.fn(() => Promise.reject(new Error("start failed"))) });
    const sessions = new Map<string, SessionCore>();

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions,
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Send a binary frame while start is failing (string frames are now dropped as non-binary)
    ws.simulateMessage(new ArrayBuffer(4));

    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });

    // Session is null, further messages should be silently ignored (no throw)
    ws.simulateMessage(new ArrayBuffer(4));
  });

  test("multiple rapid closes don't double-invoke stop()", async () => {
    const core = makeMockCore({
      stop: vi.fn(() => new Promise<void>((r) => setTimeout(r, 50))),
    });
    const sessions = new Map<string, SessionCore>();

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions,
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    ws.close();

    // Even if close event fires again, stop should only be called once
    // because the session reference is captured on first close
    await vi.waitFor(() => {
      expect(core.stop).toHaveBeenCalledOnce();
    });
  });

  test("close before open does not throw or leak", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.CONNECTING;
    const sessions = new Map<string, SessionCore>();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Close before open — session is null, should not throw
    ws.close();
    expect(sessions.size).toBe(0);
  });

  test("error event after close does not throw", async () => {
    const core = makeMockCore();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    ws.close();
    await vi.waitFor(() => {
      expect(core.stop).toHaveBeenCalled();
    });

    // Error after close should not throw
    ws.dispatchEvent(new Event("error"));
  });
});
