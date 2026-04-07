// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for server shutdown timeout behavior.
 *
 * Creates a mock runtime with controlled shutdown behavior, then exercises
 * the timeout and graceful paths in close().
 */

import { createHooks } from "hookable";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentHookMap } from "../isolate/hooks.ts";
import { silentLogger } from "./_test-utils.ts";
import type { Runtime } from "./direct-executor.ts";
import { createServer } from "./server.ts";

let mockShutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

function createMockRuntime(): Runtime {
  return {
    executeTool: vi.fn().mockResolvedValue(""),
    hooks: createHooks<AgentHookMap>(),
    toolSchemas: [],
    createSession: vi.fn() as Runtime["createSession"],
    readyConfig: { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 },
    startSession: vi.fn(),
    shutdown: (...args: Parameters<Runtime["shutdown"]>) => mockShutdown(...args),
  };
}

describe("server shutdown timeout", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(() => {
    mockShutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    server = null;
  });

  test("close calls runtime.shutdown()", async () => {
    mockShutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    server = createServer({
      runtime: createMockRuntime(),
      logger: silentLogger,
    });
    await server.listen(0);

    await server.close();
    expect(mockShutdown).toHaveBeenCalledOnce();
  }, 10_000);

  test("close resolves quickly when runtime.shutdown() resolves", async () => {
    mockShutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    server = createServer({
      runtime: createMockRuntime(),
      logger: silentLogger,
    });
    await server.listen(0);

    const start = Date.now();
    await server.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(mockShutdown).toHaveBeenCalledOnce();
  }, 10_000);

  test("close propagates when runtime.shutdown() rejects", async () => {
    mockShutdown = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("boom"));

    server = createServer({
      runtime: createMockRuntime(),
      logger: silentLogger,
    });
    await server.listen(0);

    await expect(server.close()).rejects.toThrow("boom");
  }, 10_000);
});
