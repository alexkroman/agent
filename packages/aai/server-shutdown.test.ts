// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for server shutdown timeout behavior.
 *
 * Mocks createDirectExecutor to return a runtime with controlled shutdown
 * behavior, then exercises the timeout and graceful paths in close().
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { makeAgent } from "./_test-utils.ts";
import type { DirectExecutor } from "./direct-executor.ts";

let mockShutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

vi.mock("./direct-executor.ts", () => ({
  createDirectExecutor: (): DirectExecutor => ({
    executeTool: vi.fn().mockResolvedValue(""),
    hookInvoker: {
      onConnect: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn().mockResolvedValue(undefined),
      onTurn: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn().mockResolvedValue(undefined),
      resolveTurnConfig: vi.fn().mockResolvedValue(null),
    },
    toolSchemas: [],
    createSession: vi.fn() as DirectExecutor["createSession"],
    readyConfig: { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 },
    startSession: vi.fn(),
    shutdown: (...args: Parameters<DirectExecutor["shutdown"]>) => mockShutdown(...args),
  }),
}));

const { createServer } = await import("./server.ts");

describe("server shutdown timeout", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(() => {
    mockShutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    server = null;
  });

  test("close calls runtime.shutdown()", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    mockShutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    server = createServer({
      agent: makeAgent(),
      env: {},
      logger,
    });
    await server.listen(0);

    await server.close();
    expect(mockShutdown).toHaveBeenCalledOnce();
  }, 10_000);

  test("close resolves quickly when runtime.shutdown() resolves", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    // Shutdown resolves instantly.
    mockShutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    server = createServer({
      agent: makeAgent(),
      env: {},
      logger,
      shutdownTimeoutMs: 5000,
    });
    await server.listen(0);

    const start = Date.now();
    await server.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(mockShutdown).toHaveBeenCalledOnce();
  }, 10_000);

  test("close propagates when runtime.shutdown() rejects", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    mockShutdown = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("boom"));

    server = createServer({
      agent: makeAgent(),
      env: {},
      logger,
      shutdownTimeoutMs: 5000,
    });
    await server.listen(0);

    await expect(server.close()).rejects.toThrow("boom");
  }, 10_000);
});
