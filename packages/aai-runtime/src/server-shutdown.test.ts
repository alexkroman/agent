// Copyright 2025 the AAI authors. MIT license.
/**
 * What `createRuntimeServer().close()` owes `runtime.shutdown()`.
 *
 * The describe was called "server shutdown timeout" and no test supplied a
 * shutdown that hung — because there is no timeout HERE: `close()` awaits
 * `runtime.shutdown()` outright, and the deadline belongs to the runtime
 * (`shutdownTimeoutMs`, asserted in `runtime-lifecycle.test.ts`). What the
 * server owes is that it waits for the shutdown, and propagates its failure.
 */

import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import type { Runtime } from "./runtime.ts";
import { createRuntimeServer } from "./server.ts";

/**
 * A server whose runtime does exactly what `shutdown` says.
 *
 * The shutdown fn is a PARAMETER rather than a module-level `let` reassigned in
 * an `afterEach`: with the latter, the first test in the file ran against
 * whatever the module initializer happened to leave, and the coupling between
 * a test and its double was invisible at the test.
 */
async function startServer(
  shutdown: () => Promise<void> = () => Promise.resolve(),
): Promise<{ server: ReturnType<typeof createRuntimeServer>; shutdown: ReturnType<typeof vi.fn> }> {
  const spy = vi.fn(shutdown);
  const runtime: Runtime = {
    executeTool: vi.fn().mockResolvedValue(""),
    toolSchemas: [],
    createSession: vi.fn() as Runtime["createSession"],
    readyConfig: { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 },
    startSession: vi.fn(),
    shutdown: spy,
  };
  const server = createRuntimeServer({ runtime, logger: silentLogger });
  await server.listen(0);
  return { server, shutdown: spy };
}

describe("server close → runtime.shutdown", () => {
  test("close calls runtime.shutdown()", async () => {
    const { server, shutdown } = await startServer();
    await server.close();
    expect(shutdown).toHaveBeenCalledOnce();
  }, 10_000);

  test("close WAITS for runtime.shutdown() rather than racing it", async () => {
    // The property the old `elapsed < 1000` could not see: its `shutdown` was
    // `mockResolvedValue(undefined)`, so a `close()` that never awaited it at
    // all measured the same, and the only way to fail was CI jitter. A
    // shutdown held open is what discriminates the two.
    const draining = Promise.withResolvers<void>();
    const { server, shutdown } = await startServer(() => draining.promise);

    const closed = vi.fn();
    const closing = server.close().then(closed);

    await vi.waitFor(() => {
      expect(shutdown).toHaveBeenCalledOnce();
    });
    expect(closed).not.toHaveBeenCalled();

    draining.resolve();
    await closing;
    expect(closed).toHaveBeenCalledOnce();
  }, 10_000);

  test("close propagates when runtime.shutdown() rejects", async () => {
    const { server } = await startServer(() => Promise.reject(new Error("boom")));
    await expect(server.close()).rejects.toThrow("boom");
  }, 10_000);
});
