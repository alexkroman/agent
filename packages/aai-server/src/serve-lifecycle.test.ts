// Copyright 2026 the AAI authors. MIT license.

import { EGRESS_KEEP_ALIVE_MS } from "@alexkroman1/aai-runtime/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerLiveStream, resetLiveStreams } from "./live-streams.ts";
import {
  createShutdownHandler,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  startService,
} from "./serve-lifecycle.ts";
import { captureLogs } from "./test-utils.ts";

beforeEach(() => {
  // Reset, not drain: a shutdown latches the registry closed, so draining here
  // would make every registerLiveStream below end its stream on the spot.
  resetLiveStreams();
});

// Every spec here drives a shutdown or a listen, both of which announce
// themselves; two also assert on what was announced.
const logs = captureLogs();

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

  // Long-lived responses never end on their own, so `close()` would wait out
  // the fallback and `process.exit` would destroy them MID-CHUNK — a
  // truncated chunked body to whatever is reading (Modal's ASGI proxy, in
  // production). They have to be ended BEFORE the close, which is also what
  // lets the close complete at all.
  //
  // And before the TEARDOWN, which sleeps SHUTDOWN_GRACE_MS and then awaits one
  // drain request per resident guest: Modal SIGKILLs the container when its
  // stop grace lapses, so anything slow in front of the ending made it
  // contingent on sandbox teardown finishing in time.
  it("ends live streams first — before teardown and the close", async () => {
    const order: string[] = [];
    registerLiveStream(() => order.push("end-stream"));
    const shutdown = createShutdownHandler({
      onShutdown: async () => {
        order.push("teardown");
      },
      closeServer: (cb) => {
        order.push("close");
        cb();
      },
      exit: vi.fn(),
    });

    await shutdown();

    expect(order).toEqual(["end-stream", "teardown", "close"]);
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
    expect(logs.all()).toContainEqual({
      level: "warn",
      msg: "serve shutdown teardown failed",
      ctx: { error: "sandbox boom" },
    });
  });

  // The `fallbackMs` timer below is armed only AFTER onShutdown settles, so it
  // could never cover the teardown itself — and the teardown is the half that
  // hangs (a resident guest's retirement goes through the spawn's readiness
  // promise; the Modal calls under it carry no timeout at all). Past the
  // container's stop grace the platform SIGKILLs, so an unbounded teardown did
  // not merely delay the exit: it skipped the warning below AND the graceful
  // close, silently.
  it("bounds a teardown that never settles, then closes and exits", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const closeServer = vi.fn((cb: () => void) => cb());
      const shutdown = createShutdownHandler({
        // A guest whose boot — or whose Modal terminate — never comes back.
        onShutdown: () => new Promise<void>(() => undefined),
        closeServer,
        exit,
        teardownTimeoutMs: 20_000,
      });

      const settled = vi.fn();
      void shutdown().then(settled);

      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toHaveBeenCalled();
      expect(logs.all()).toContainEqual({
        level: "warn",
        msg: "serve shutdown teardown failed",
        ctx: { error: "teardown exceeded 20000ms; exiting anyway" },
      });
      expect(closeServer).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
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

      expect(logs.warns()).toContain(
        "serve shutdown timed out waiting for connections to close; exiting",
      );
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startService", () => {
  /** A fake server that records handlers and fires `listening` on demand. */
  function fakeServer() {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    return {
      server: {
        // The two socket reaps `startService` assigns — declared so a test can
        // read them back typed. `undefined` until it sets them, which is what
        // the "before listening" case below distinguishes.
        keepAliveTimeout: undefined as number | undefined,
        headersTimeout: undefined as number | undefined,
        on: (event: string, cb: (arg?: unknown) => void) => {
          handlers[event] = cb;
          if (event === "listening") cb();
        },
        close: vi.fn((cb?: () => void) => cb?.()),
      },
      handlers,
    };
  }

  it("sets the socket reaps ABOVE the guest's own client keep-alive", async () => {
    // The defect this pins: both were left to Node's defaults — keep-alive 5s —
    // under a guest client that holds its end for 30s. The shorter side decides,
    // so the client's value was unreachable and a journal call more than 5s
    // after the previous one opened a fresh socket. Asserted as an ORDERING
    // against the imported constant rather than against literals, because the
    // two drifting apart in different packages IS the bug.
    const { server } = fakeServer();
    await startService({
      label: "AAI test service",
      fetch: () => new Response("ok"),
      port: 1234,
      onShutdown: async () => undefined,
      serveImpl: () => server,
    });

    expect(server.keepAliveTimeout).toBeGreaterThan(EGRESS_KEEP_ALIVE_MS);
    // Node races the two, so a headers timeout at or below the keep-alive can
    // reap a socket whose next request's headers are still arriving.
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout ?? 0);
    // And still inside Node's own 60s default, so raising the keep-alive did not
    // widen the slowloris window it shares a socket with.
    expect(server.headersTimeout).toBeLessThanOrEqual(60_000);
  });

  it("sets them BEFORE the server reports listening", async () => {
    // A connection served under the 5s default is a connection the fix missed.
    let atListening: number | undefined;
    const { server } = fakeServer();
    const on = server.on;
    server.on = (event: string, cb: (arg?: unknown) => void) => {
      if (event === "listening") atListening = server.keepAliveTimeout;
      on(event, cb);
    };

    await startService({
      label: "AAI test service",
      fetch: () => new Response("ok"),
      port: 1234,
      onShutdown: async () => undefined,
      serveImpl: () => server,
    });

    expect(atListening).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
  });

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
    expect(logs.infos()).toContain("serve AAI test service listening on http://localhost:1234");
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
