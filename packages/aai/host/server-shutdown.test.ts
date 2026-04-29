// Copyright 2025 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import type { Runtime } from "./runtime.ts";
import { createServer } from "./server.ts";

let mockShutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

function createMockRuntime(): Runtime {
  return {
    executeTool: vi.fn().mockResolvedValue(""),
    toolSchemas: [],
    createSession: vi.fn() as Runtime["createSession"],
    readyConfig: { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 },
    startSession: vi.fn(),
    shutdown: (...args: Parameters<Runtime["shutdown"]>) => mockShutdown(...args),
  };
}

async function startServer(): Promise<ReturnType<typeof createServer>> {
  const server = createServer({ runtime: createMockRuntime(), logger: silentLogger });
  await server.listen(0);
  return server;
}

describe("server shutdown timeout", () => {
  afterEach(() => {
    mockShutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  });

  test("close calls runtime.shutdown()", async () => {
    const server = await startServer();
    await server.close();
    expect(mockShutdown).toHaveBeenCalledOnce();
  }, 10_000);

  test("close resolves quickly when runtime.shutdown() resolves", async () => {
    const server = await startServer();

    const start = Date.now();
    await server.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(mockShutdown).toHaveBeenCalledOnce();
  }, 10_000);

  test("close propagates when runtime.shutdown() rejects", async () => {
    mockShutdown = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("boom"));

    const server = await startServer();
    await expect(server.close()).rejects.toThrow("boom");
  }, 10_000);
});
