// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for server shutdown timeout behavior.
 *
 * Mocks wireSessionSocket to capture the sessions map, injects fake sessions
 * to exercise the timeout and graceful paths in close().
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { makeAgent } from "./_test-utils.ts";
import type { Session } from "./session.ts";

let capturedSessions: Map<string, Session> | null = null;
let injectedSession: Partial<Session> = {};

vi.mock("./ws-handler.ts", () => ({
  wireSessionSocket(_ws: unknown, opts: { sessions: Map<string, Session> }) {
    capturedSessions = opts.sessions;
    opts.sessions.set("injected", injectedSession as Session);
  },
}));

const { createServer } = await import("./server.ts");

describe("server shutdown timeout", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(() => {
    capturedSessions = null;
    server = null;
  });

  test("close resolves after timeout when session.stop() hangs", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    // Session whose stop() never resolves.
    injectedSession = {
      stop: () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
    };

    server = createServer({
      agent: makeAgent(),
      env: {},
      logger,
      shutdownTimeoutMs: 100,
    });
    await server.listen(0);

    // Connect + immediately close the WS so the HTTP server can shut down.
    const ws = new WebSocket(`ws://localhost:${server.port}/websocket`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.close();
    // Wait for the close to propagate.
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedSessions?.size).toBe(1);

    const start = Date.now();
    await server.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Shutdown timeout"));
  }, 10_000);

  test("close resolves quickly when sessions stop promptly", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    // Session whose stop() resolves instantly.
    injectedSession = { stop: () => Promise.resolve() };

    server = createServer({
      agent: makeAgent(),
      env: {},
      logger,
      shutdownTimeoutMs: 5000,
    });
    await server.listen(0);

    const ws = new WebSocket(`ws://localhost:${server.port}/websocket`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.close();
    await new Promise((r) => setTimeout(r, 50));

    const start = Date.now();
    await server.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("Shutdown timeout"));
  }, 10_000);

  test("close logs warning when session.stop() rejects", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    injectedSession = {
      stop: () => Promise.reject(new Error("boom")),
    };

    server = createServer({
      agent: makeAgent(),
      env: {},
      logger,
      shutdownTimeoutMs: 5000,
    });
    await server.listen(0);

    const ws = new WebSocket(`ws://localhost:${server.port}/websocket`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.close();
    await new Promise((r) => setTimeout(r, 50));

    await server.close();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Session stop failed during close"),
    );
  }, 10_000);
});
