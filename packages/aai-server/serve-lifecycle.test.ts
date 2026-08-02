// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createShutdownHandler, drainActiveSessions, startService } from "./serve-lifecycle.ts";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("createShutdownHandler", () => {
  it("runs teardown, then closes the server, then exits 0", async () => {
    const order: string[] = [];
    const exit = vi.fn(() => order.push("exit"));
    const shutdown = createShutdownHandler({
      onShutdown: async () => {
        order.push("teardown");
      },
      closeServer: (cb) => {
        order.push("close");
        cb();
      },
      exit,
    });

    await shutdown();

    expect(order).toEqual(["teardown", "close", "exit"]);
  });

  // A platform that signals twice, or an impatient operator, must not run
  // sandbox teardown a second time.
  it("is idempotent across repeated signals", async () => {
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdownHandler({
      onShutdown,
      closeServer: (cb) => cb(),
      exit: vi.fn(),
    });

    await shutdown();
    await shutdown();
    await shutdown();

    expect(onShutdown).toHaveBeenCalledOnce();
  });

  it("still closes and exits when teardown throws", async () => {
    const exit = vi.fn();
    const closeServer = vi.fn((cb: () => void) => cb());
    const shutdown = createShutdownHandler({
      onShutdown: () => Promise.reject(new Error("sandbox boom")),
      closeServer,
      exit,
    });

    await shutdown();

    expect(closeServer).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(console.warn).toHaveBeenCalledWith("Shutdown teardown failed:", "sandbox boom");
  });

  // The drift this module exists to prevent: the combined entry's copy had
  // lost this warning, so a hung shutdown exited silently.
  it("warns and exits when connections never close", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const shutdown = createShutdownHandler({
        onShutdown: async () => undefined,
        // Never invokes the callback — a connection that will not end.
        closeServer: () => undefined,
        exit,
        fallbackMs: 3000,
      });

      await shutdown();
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3000);

      expect(console.warn).toHaveBeenCalledWith(
        "Shutdown timed out waiting for connections to close; exiting",
      );
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("drainActiveSessions", () => {
  it("returns once the live-session count reaches zero", async () => {
    let live = 2;
    const drain = drainActiveSessions({
      activeCount: () => live,
      env: { SHUTDOWN_DRAIN_MS: "5000" },
    });
    live = 0;

    await drain;

    expect(console.warn).not.toHaveBeenCalled();
  });

  it("warns when the deadline passes with sessions still in flight", async () => {
    await drainActiveSessions({
      activeCount: () => 3,
      env: { SHUTDOWN_DRAIN_MS: "0" },
    });

    expect(console.warn).toHaveBeenCalledWith(
      "Drain deadline reached; closing sessions still in flight",
      { remaining: 3 },
    );
  });
});

describe("startService", () => {
  /** A fake server that records handlers and fires `listening` on demand. */
  function fakeServer() {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    return {
      server: {
        on: (event: string, cb: (arg?: unknown) => void) => {
          handlers[event] = cb;
          if (event === "listening") cb();
        },
        close: vi.fn((cb?: () => void) => cb?.()),
      },
      handlers,
    };
  }

  it("injects websockets before listening and logs the service label", async () => {
    const { server } = fakeServer();
    const injectWebSocket = vi.fn();

    await startService({
      label: "AAI test service",
      fetch: () => new Response("ok"),
      port: 1234,
      injectWebSocket,
      onShutdown: async () => undefined,
      serveImpl: () => server,
    });

    expect(injectWebSocket).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith(
      "AAI test service listening on http://localhost:1234",
    );
  });

  it("passes the caller's fetch and port to the server", async () => {
    const { server } = fakeServer();
    const serveImpl = vi.fn(() => server);
    const fetchFn = () => new Response("ok");

    await startService({
      label: "AAI test service",
      fetch: fetchFn,
      port: 4321,
      onShutdown: async () => undefined,
      serveImpl,
    });

    expect(serveImpl).toHaveBeenCalledWith({ fetch: fetchFn, port: 4321 });
  });
});
