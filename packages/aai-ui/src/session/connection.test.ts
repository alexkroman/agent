// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit specs for the connection statechart, over virtual time and a socket
 * double with NO reconnect machinery (partysocket's `close` decisions arrive as
 * the `reconnecting` flag the effects report).
 *
 * The session-level suites (`handshake.test.ts`, `reconnect.test.ts`,
 * `close.test.ts`, the fuzz harnesses) prove the wiring over partysocket; these
 * state what the machine decides: when the handshake deadline fires, what
 * disarms it, that every ending runs the one teardown, and what the idle
 * retirement declines.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MockWebSocket, recordingWebSocketClass } from "../_session-core-test-utils.ts";
import { type ConnectionEffects, createConnection } from "./connection.ts";
import type { SessionConfigMessage } from "./messages.ts";

const CONFIG: SessionConfigMessage = { sampleRate: 16_000, ttsSampleRate: 24_000, sid: "s" };

function harness(opts: { canRedial?: boolean; reconnecting?: boolean; fatal?: boolean } = {}) {
  const sockets: MockWebSocket[] = [];
  const Socket = recordingWebSocketClass((s) => sockets.push(s));
  const reconnecting = { value: opts.reconnecting ?? false };
  const effects = {
    dial: vi.fn(() => new Socket("ws://test")),
    release: vi.fn((socket: WebSocket) => socket.close()),
    abandon: vi.fn(),
    receive: vi.fn((data: unknown) => (data === "config" ? CONFIG : undefined)),
    opened: vi.fn(),
    configured: vi.fn(),
    fatal: vi.fn(() => opts.fatal ?? false),
    retryPending: vi.fn(() => reconnecting.value),
    canRedial: vi.fn(() => opts.canRedial ?? false),
    redial: vi.fn(),
    retrying: vi.fn(),
    closed: vi.fn(),
    exhausted: vi.fn(),
  } satisfies ConnectionEffects;
  const connection = createConnection(effects);
  return { connection, effects, sockets, reconnecting };
}

describe("createConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dials on DIAL and walks dialing → awaitingHandshake → live", () => {
    const { connection, effects, sockets } = harness();
    expect(connection.phase()).toBe("closed");
    connection.dial();
    expect(effects.dial).toHaveBeenCalledOnce();
    expect(connection.phase()).toBe("dialing");
    sockets[0]?.simulateOpen();
    expect(effects.opened).toHaveBeenCalledOnce();
    expect(connection.phase()).toBe("awaitingHandshake");
    sockets[0]?.simulateMessage("config");
    expect(effects.configured).toHaveBeenCalledWith(CONFIG);
    expect(connection.phase()).toBe("live");
  });

  it("the handshake deadline fires ten seconds after an attempt opens, and not before", async () => {
    const { connection, effects, sockets } = harness();
    connection.dial();
    sockets[0]?.simulateOpen();
    await vi.advanceTimersByTimeAsync(9999);
    expect(effects.exhausted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(effects.exhausted).toHaveBeenCalledOnce();
    expect(connection.phase()).toBe("closed");
  });

  it("a socket that cannot re-dial is exhausted on the first timeout, after the teardown", async () => {
    const { connection, effects, sockets } = harness({ canRedial: false });
    connection.dial();
    sockets[0]?.simulateOpen();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(effects.redial).not.toHaveBeenCalled();
    expect(effects.release).toHaveBeenCalledOnce();
    expect(effects.release.mock.invocationCallOrder[0]).toBeLessThan(
      effects.exhausted.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("re-dials twice, then spends the CONSECUTIVE budget on the third timeout", async () => {
    const { connection, effects, sockets } = harness({ canRedial: true });
    connection.dial();
    for (let i = 0; i < 2; i++) {
      sockets[0]?.simulateOpen();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(connection.phase()).toBe("dialing");
    }
    expect(effects.redial).toHaveBeenCalledTimes(2);
    expect(effects.retrying).toHaveBeenCalledTimes(2);
    sockets[0]?.simulateOpen();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(effects.exhausted).toHaveBeenCalledOnce();
  });

  it("a completed handshake resets the budget; a close does not", async () => {
    const { connection, effects, sockets, reconnecting } = harness({ canRedial: true });
    reconnecting.value = true;
    connection.dial();
    const socket = sockets[0];
    socket?.simulateOpen();
    await vi.advanceTimersByTimeAsync(10_000);
    socket?.simulateOpen();
    socket?.simulateMessage("config");
    // Two more timeouts would be the third strike counted per connection.
    for (let i = 0; i < 2; i++) {
      socket?.simulateOpen();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(effects.exhausted).not.toHaveBeenCalled();
    expect(connection.phase()).toBe("dialing");
  });

  it.each([
    ["a config frame", (h: ReturnType<typeof harness>) => h.sockets[0]?.simulateMessage("config")],
    ["a close", (h: ReturnType<typeof harness>) => h.sockets[0]?.simulateClose()],
    ["a hang-up", (h: ReturnType<typeof harness>) => h.connection.hangUp()],
    ["a fresh dial", (h: ReturnType<typeof harness>) => h.connection.dial()],
  ])("%s disarms the deadline", async (_label, stop) => {
    const h = harness();
    h.connection.dial();
    h.sockets[0]?.simulateOpen();
    stop(h);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.effects.exhausted).not.toHaveBeenCalled();
  });

  it("re-opening restarts the deadline rather than stacking a second", async () => {
    const { connection, effects, sockets } = harness();
    connection.dial();
    sockets[0]?.simulateOpen();
    await vi.advanceTimersByTimeAsync(6000);
    sockets[0]?.simulateOpen();
    await vi.advanceTimersByTimeAsync(6000);
    expect(effects.exhausted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(effects.exhausted).toHaveBeenCalledOnce();
  });

  it("every ending releases the socket exactly once and detaches its listeners", () => {
    const { connection, effects, sockets } = harness();
    connection.dial();
    connection.dial();
    expect(effects.release).toHaveBeenCalledTimes(1);
    expect(effects.release).toHaveBeenCalledWith(sockets[0]);
    // The first socket's listeners are gone: its frames reach nothing.
    sockets[0]?.simulateMessage("config");
    expect(effects.configured).not.toHaveBeenCalled();
    connection.hangUp();
    connection.hangUp();
    expect(effects.release).toHaveBeenCalledTimes(2);
    expect(connection.phase()).toBe("closed");
  });

  it("a close partysocket retries goes back to dialing and forgets the socket error", () => {
    const { connection, effects, sockets } = harness({ reconnecting: true });
    connection.dial();
    const socket = sockets[0];
    socket?.simulateOpen();
    socket?.simulateError();
    socket?.simulateClose();
    expect(effects.retrying).toHaveBeenCalledOnce();
    expect(connection.phase()).toBe("dialing");
    expect(effects.release).not.toHaveBeenCalled();
  });

  it("a terminal close tears down, then reports the socket error", () => {
    const { connection, effects, sockets } = harness();
    connection.dial();
    sockets[0]?.simulateError();
    sockets[0]?.simulateClose();
    expect(connection.phase()).toBe("closed");
    expect(effects.closed).toHaveBeenCalledWith("WebSocket connection error");
    expect(effects.release.mock.invocationCallOrder[0]).toBeLessThan(
      effects.closed.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("a FATAL session's close is not retried", () => {
    const { connection, effects, sockets } = harness({ reconnecting: true, fatal: true });
    connection.dial();
    sockets[0]?.simulateClose();
    expect(effects.retrying).not.toHaveBeenCalled();
    expect(effects.closed).toHaveBeenCalledWith(null);
  });

  it("an idle retirement declines the next retry, and a fresh dial clears it", () => {
    const { connection, effects, sockets } = harness({ reconnecting: true });
    connection.dial();
    connection.retire();
    sockets[0]?.simulateClose();
    expect(effects.retrying).not.toHaveBeenCalled();
    expect(connection.phase()).toBe("closed");

    connection.dial();
    sockets[1]?.simulateClose();
    expect(effects.retrying).toHaveBeenCalledOnce();
  });

  it("the caller's signal aborting hangs up", () => {
    const { connection, effects } = harness();
    const controller = new AbortController();
    connection.dial(controller.signal);
    controller.abort();
    expect(effects.abandon).toHaveBeenCalledOnce();
  });
});
