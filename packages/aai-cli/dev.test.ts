// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";

const { mockCleanup, mockStartDevServer } = vi.hoisted(() => {
  const mockCleanup = vi.fn();
  return { mockCleanup, mockStartDevServer: vi.fn(async () => mockCleanup) };
});

vi.mock("./_dev-server.ts", () => ({
  startDevServer: mockStartDevServer,
}));

vi.mock("./_ui.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_ui.ts")>()),
  log: (await import("./_test-utils.ts")).makeMockLog(),
}));

import { executeDev } from "./dev.ts";

/**
 * Run executeDev with process.on intercepted, so signal/error handlers are
 * captured instead of registered on the real test process (an actual
 * uncaughtException handler would swallow other tests' failures).
 */
async function withCapturedHandlers(
  fn: (handlers: Map<string, (...args: unknown[]) => void>) => Promise<void>,
): Promise<void> {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const onSpy = vi.spyOn(process, "on").mockImplementation(((
    event: string,
    handler: (...args: unknown[]) => void,
  ) => {
    handlers.set(event, handler);
    return process;
  }) as typeof process.on);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  try {
    await fn(handlers);
  } finally {
    onSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe("executeDev", () => {
  test("starts the dev server and returns the url", async () => {
    await withCapturedHandlers(async () => {
      mockCleanup.mockResolvedValue(undefined);
      const result = await executeDev({ cwd: "/tmp/agent", port: "3123" });
      expect(mockStartDevServer).toHaveBeenCalledWith({ cwd: "/tmp/agent", port: 3123 });
      expect(result).toEqual({ ok: true, data: { url: "http://localhost:3123" } });
    });
  });

  // SIGINT followed by SIGTERM (common under process supervisors) must not run
  // cleanup twice concurrently — double server close is ERR_SERVER_NOT_RUNNING
  // noise and a double runtime shutdown.
  test("second signal joins the in-flight cleanup instead of re-running it", async () => {
    await withCapturedHandlers(async (handlers) => {
      let releaseCleanup!: () => void;
      mockCleanup.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
      );

      await executeDev({ cwd: "/tmp/agent", port: "3123" });
      const sigint = handlers.get("SIGINT");
      const sigterm = handlers.get("SIGTERM");
      expect(sigint).toBeDefined();
      expect(sigterm).toBeDefined();

      sigint?.();
      sigterm?.();
      sigint?.();
      expect(mockCleanup).toHaveBeenCalledTimes(1);

      releaseCleanup();
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(process.exit).toHaveBeenCalledTimes(1);
    });
  });

  // The defense-in-depth process handlers must log and keep the host alive —
  // one bad session's stray rejection/throw must not crash every other one.
  test("unhandledRejection and uncaughtException handlers log without exiting", async () => {
    await withCapturedHandlers(async (handlers) => {
      mockCleanup.mockResolvedValue(undefined);
      await executeDev({ cwd: "/tmp/agent", port: "3123" });
      const { log } = await import("./_ui.ts");
      const logError = log.error as ReturnType<typeof vi.fn>;
      logError.mockClear();

      handlers.get("unhandledRejection")?.(new Error("socket died"));
      expect(logError).toHaveBeenCalledWith(expect.stringContaining("socket died"));

      handlers.get("uncaughtException")?.(new Error("callback threw"));
      expect(logError).toHaveBeenCalledWith(expect.stringContaining("callback threw"));

      expect(process.exit).not.toHaveBeenCalled();
    });
  });
});
