// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit specs for the platform socket's reconnect statechart.
 *
 * `socket.test.ts` asserts the same loop end-to-end through `createPlatformSocket`
 * and its pending-call map; here every effect is a spy, so the orderings that
 * used to be guarded by hand — an event from a socket an earlier drop already
 * retired, a `close()` while a reconnect is scheduled, a dial that throws — are
 * one call away. The timers are virtual, for the reason `.agents/testing.md`
 * gives about specs that observe one.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HeaderWebSocket } from "../_ws.ts";
import {
  createPlatformSocketLifecycle,
  type PlatformSocketLifecycleEffects,
} from "./socket-lifecycle.ts";

const HEARTBEAT = 1000;
const PONG_DEADLINE = 500;
const BACKOFF = 100;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A `ws`-shaped socket a spec drives by hand. */
function fakeSocket() {
  type Listener = (event: { data: unknown; code?: number; message?: string }) => void;
  const listeners = new Map<string, Listener[]>();
  const sent: string[] = [];
  let readyState = 0;
  let sendThrows = false;
  const close = vi.fn((_code?: number) => {
    readyState = 3;
  });
  const socket: HeaderWebSocket = {
    get readyState(): number {
      return readyState;
    },
    send(data: string): void {
      if (sendThrows) throw new Error("EPIPE");
      sent.push(data);
    },
    close,
    addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  const emit = (type: string, event: { data: unknown; code?: number; message?: string }) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    socket,
    close,
    open(): void {
      readyState = 1;
      emit("open", { data: undefined });
    },
    deliver(frame: unknown): void {
      emit("message", { data: JSON.stringify(frame) });
    },
    deliverRaw(text: string): void {
      emit("message", { data: text });
    },
    fail(code: number): void {
      readyState = 3;
      emit("close", { data: undefined, code });
    },
    error(message: string): void {
      emit("error", { data: undefined, message });
    },
    breakSend(): void {
      sendThrows = true;
    },
    pings(): { t: string; id: number }[] {
      return sent
        .map((text) => JSON.parse(text) as { t: string; id: number })
        .filter((frame) => frame.t === "ping");
    },
  };
}

type Fake = ReturnType<typeof fakeSocket>;

/** A lifecycle over spied effects; each dial hands out the next fake socket. */
function makeLifecycle(overrides: Partial<PlatformSocketLifecycleEffects> = {}) {
  const dialed: Fake[] = [];
  let id = 100;
  const spies = {
    dial: vi.fn(() => {
      const next = fakeSocket();
      dialed.push(next);
      return next.socket;
    }),
    nextId: vi.fn(() => id++),
    settle: vi.fn(),
    sweep: vi.fn(),
    failInFlight: vi.fn((_reason: string) => undefined),
    backoffMs: vi.fn((_attempt: number) => BACKOFF),
    log: vi.fn(
      (_level: "debug" | "warn", _message: string, _fields?: Record<string, unknown>) => undefined,
    ),
    heartbeatMs: HEARTBEAT,
    pongDeadlineMs: PONG_DEADLINE,
  } satisfies PlatformSocketLifecycleEffects;
  const lifecycle = createPlatformSocketLifecycle({ ...spies, ...overrides });
  const current = (): Fake => {
    const last = dialed.at(-1);
    if (last === undefined) throw new Error("nothing dialed");
    return last;
  };
  return { spies, lifecycle, dialed, current };
}

describe("connecting and opening", () => {
  test("dials at once, and exposes the socket only once it has opened", () => {
    const { spies, lifecycle, current } = makeLifecycle();
    expect(spies.dial).toHaveBeenCalledTimes(1);
    expect(lifecycle.phase()).toBe("connecting");
    expect(lifecycle.openSocket()).toBeUndefined();
    current().open();
    expect(lifecycle.phase()).toBe("open");
    expect(lifecycle.openSocket()).toBe(current().socket);
  });

  test("hands replies to settle and logs an unreadable frame", () => {
    const { spies, current } = makeLifecycle();
    current().open();
    current().deliver({ t: "res", id: 7, status: 200, body: "ok" });
    current().deliverRaw("not json");
    expect(spies.settle).toHaveBeenCalledWith({ t: "res", id: 7, status: 200, body: "ok" });
    expect(spies.log).toHaveBeenCalledWith("debug", "platform socket dropped an unreadable frame");
  });
});

describe("the heartbeat", () => {
  test("pings after a heartbeat and goes back to idle on the matching pong", async () => {
    const { spies, lifecycle, current } = makeLifecycle();
    current().open();
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(spies.sweep).toHaveBeenCalledTimes(1);
    const [ping] = current().pings();
    expect(ping).toEqual({ t: "ping", id: 100 });
    current().deliver({ t: "pong", id: 100 });
    await vi.advanceTimersByTimeAsync(PONG_DEADLINE);
    expect(lifecycle.phase()).toBe("open");
    // And the next heartbeat pings again, with a fresh id.
    await vi.advanceTimersByTimeAsync(HEARTBEAT - PONG_DEADLINE);
    expect(current().pings().at(-1)).toEqual({ t: "ping", id: 101 });
  });

  test("a missed pong drops the socket, fails the calls on it and backs off", async () => {
    const { spies, lifecycle, current } = makeLifecycle();
    const first = current();
    first.open();
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    // A pong for some OTHER ping is not the one outstanding.
    first.deliver({ t: "pong", id: 99 });
    await vi.advanceTimersByTimeAsync(PONG_DEADLINE);
    expect(lifecycle.phase()).toBe("backoff");
    expect(spies.failInFlight).toHaveBeenCalledWith("heartbeat timed out");
    expect(spies.sweep).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledWith(1001);
    expect(lifecycle.openSocket()).toBeUndefined();
  });

  test("a ping write that throws does not stop the loop", async () => {
    const { spies, lifecycle, current } = makeLifecycle();
    current().open();
    current().breakSend();
    await vi.advanceTimersByTimeAsync(HEARTBEAT + PONG_DEADLINE);
    expect(spies.failInFlight).toHaveBeenCalledWith("heartbeat timed out");
    await vi.advanceTimersByTimeAsync(BACKOFF);
    expect(spies.dial).toHaveBeenCalledTimes(2);
    expect(lifecycle.phase()).toBe("connecting");
  });
});

describe("reconnecting", () => {
  test("a close fails the calls in flight and redials after the backoff", async () => {
    const { spies, lifecycle, current } = makeLifecycle();
    current().open();
    current().fail(1006);
    expect(lifecycle.phase()).toBe("backoff");
    expect(spies.failInFlight).toHaveBeenCalledWith("closed (1006)");
    expect(spies.backoffMs).toHaveBeenLastCalledWith(1);
    await vi.advanceTimersByTimeAsync(BACKOFF - 1);
    expect(spies.dial).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spies.dial).toHaveBeenCalledTimes(2);
  });

  test("an error is a warn and a drop", () => {
    const { spies, lifecycle, current } = makeLifecycle();
    current().error("401");
    expect(lifecycle.phase()).toBe("backoff");
    expect(spies.failInFlight).toHaveBeenCalledWith("errored");
    expect(spies.log).toHaveBeenCalledWith("warn", "platform socket error", { error: "401" });
  });

  test("a dial that throws backs off and tries again", async () => {
    let throws = true;
    const socket = fakeSocket();
    const { spies, lifecycle } = makeLifecycle({
      dial: () => {
        if (throws) throw new Error("bad url");
        return socket.socket;
      },
    });
    expect(lifecycle.phase()).toBe("backoff");
    expect(spies.log).toHaveBeenCalledWith("warn", "platform socket could not be created", {
      error: "Error: bad url",
    });
    throws = false;
    await vi.advanceTimersByTimeAsync(BACKOFF);
    socket.open();
    expect(lifecycle.openSocket()).toBe(socket.socket);
  });

  test("consecutive failures grow the attempt count, and an open resets it", async () => {
    const { spies, current } = makeLifecycle();
    current().fail(1006);
    await vi.advanceTimersByTimeAsync(BACKOFF);
    current().fail(1006);
    expect(spies.backoffMs.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(BACKOFF);
    current().open();
    current().fail(1006);
    expect(spies.backoffMs).toHaveBeenLastCalledWith(1);
  });

  test("events from a retired socket are dropped by the stopped actor", async () => {
    // What `socket !== opening` enforced by hand three times.
    const { spies, lifecycle, dialed } = makeLifecycle();
    const [first] = dialed;
    first?.open();
    first?.fail(1006);
    await vi.advanceTimersByTimeAsync(BACKOFF);
    const second = dialed[1];
    second?.open();
    first?.deliver({ t: "res", id: 1, status: 200, body: "late" });
    first?.fail(1006);
    first?.error("late");
    expect(spies.settle).not.toHaveBeenCalled();
    expect(spies.failInFlight).toHaveBeenCalledTimes(1);
    expect(lifecycle.openSocket()).toBe(second?.socket);
  });
});

describe("close()", () => {
  test("drops an open socket and never redials", async () => {
    const { spies, lifecycle, current } = makeLifecycle();
    current().open();
    lifecycle.close();
    expect(lifecycle.phase()).toBe("closed");
    expect(spies.failInFlight).toHaveBeenCalledWith("closed by this process");
    expect(current().close).toHaveBeenCalledWith(1001);
    // The close our own `close(1001)` provokes arrives at a stopped actor.
    current().fail(1001);
    await vi.advanceTimersByTimeAsync(HEARTBEAT * 10);
    expect(spies.dial).toHaveBeenCalledTimes(1);
    expect(spies.failInFlight).toHaveBeenCalledTimes(1);
  });

  test("cancels a scheduled reconnect, and is idempotent", async () => {
    const { spies, lifecycle, current } = makeLifecycle();
    current().fail(1006);
    lifecycle.close();
    lifecycle.close();
    await vi.advanceTimersByTimeAsync(BACKOFF * 10);
    expect(spies.dial).toHaveBeenCalledTimes(1);
    expect(lifecycle.phase()).toBe("closed");
  });
});
