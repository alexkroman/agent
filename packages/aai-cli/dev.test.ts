// Copyright 2025 the AAI authors. MIT license.
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockCleanup, mockStartDevServer, mockNotify } = vi.hoisted(() => {
  const mockCleanup = vi.fn();
  return {
    mockCleanup,
    mockStartDevServer: vi.fn(async () => mockCleanup),
    mockNotify: vi.fn(),
  };
});

vi.mock("./_dev-server.ts", () => ({
  startDevServer: mockStartDevServer,
}));

vi.mock("./_ui.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_ui.ts")>()),
  log: (await import("./_test-utils.ts")).makeMockLog(),
  notify: mockNotify,
}));

import { executeDev } from "./dev.ts";

// `mockCleanup`, `mockStartDevServer` and `mockNotify` are module-level
// `vi.fn()`s. `restoreMocks: true` registers only `vi.spyOn` mocks, so it
// clears none of their call history — without this, the
// `toHaveBeenCalledTimes(1)` assertions below count every call since the file
// started rather than the ones this test made.
beforeEach(() => {
  vi.clearAllMocks();
});

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
      const inFlight = Promise.withResolvers<void>();
      mockCleanup.mockReturnValue(inFlight.promise);

      await executeDev({ cwd: "/tmp/agent", port: "3123" });
      const sigint = handlers.get("SIGINT");
      const sigterm = handlers.get("SIGTERM");
      expect(sigint).toBeDefined();
      expect(sigterm).toBeDefined();

      sigint?.();
      sigterm?.();
      sigint?.();
      expect(mockCleanup).toHaveBeenCalledTimes(1);

      inFlight.resolve();
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(process.exit).toHaveBeenCalledTimes(1);
    });
  });

  // The defense-in-depth process handlers must report and keep the host alive —
  // one bad session's stray rejection/throw must not crash every other one.
  //
  // They report through `notify`, not `log`: `aai dev` is long-running and JSON
  // mode (auto-detected on a pipe) no-ops every `log` method for the rest of the
  // process, so a piped dev server hid these entirely. Asserting on `notify`
  // is what keeps a revert to `log.error` from silently going unnoticed again.
  test("unhandledRejection and uncaughtException handlers report without exiting", async () => {
    await withCapturedHandlers(async (handlers) => {
      mockCleanup.mockResolvedValue(undefined);
      await executeDev({ cwd: "/tmp/agent", port: "3123" });
      mockNotify.mockClear();

      handlers.get("unhandledRejection")?.(new Error("socket died"));
      expect(mockNotify).toHaveBeenCalledWith("error", expect.stringContaining("socket died"));

      handlers.get("uncaughtException")?.(new Error("callback threw"));
      expect(mockNotify).toHaveBeenCalledWith("error", expect.stringContaining("callback threw"));

      expect(process.exit).not.toHaveBeenCalled();
    });
  });
});
