// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit specs for one client socket's session lifecycle statechart.
 *
 * The five `ws-handler*.test.ts` files assert these rules end-to-end through a
 * fake socket, a fake session and a real claim map; here a phase is one `send`
 * away, so the orderings that used to need a whole connection to describe — a
 * close arriving mid-`start()`, a second close after a failed one — are cheap.
 *
 * Two groups earn their place by pinning ACTION ORDER rather than behaviour:
 * both bugs found while writing this module were XState running a source
 * state's exit actions before the target's entry ones, and neither is visible
 * in the state diagram.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createWsSessionLifecycle,
  type WsSessionLifecycleEffects,
} from "./ws-session-lifecycle.ts";

/** A lifecycle over spied effects, with `start()` held open by default. */
function makeLifecycle(overrides: Partial<WsSessionLifecycleEffects> = {}) {
  const spies = {
    // Never settles unless a spec overrides it: a `start()` that resolved on
    // its own would decide half the orderings below before the spec got there.
    start: vi.fn(() => new Promise<void>(() => undefined)),
    announceReady: vi.fn(),
    drainBuffer: vi.fn(),
    dropBuffer: vi.fn(),
    endSession: vi.fn(),
    failClient: vi.fn(),
  } satisfies WsSessionLifecycleEffects;
  const effects: WsSessionLifecycleEffects = { ...spies, ...overrides };
  return { spies, lifecycle: createWsSessionLifecycle(effects) };
}

describe("phases", () => {
  test("starts connecting, and neither buffers nor dispatches", () => {
    const { lifecycle } = makeLifecycle();
    expect(lifecycle.phase()).toBe("connecting");
    expect(lifecycle.buffering()).toBe(false);
    expect(lifecycle.dispatches()).toBe(false);
  });

  test("a created session buffers rather than dispatching", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "CREATED" });
    expect(lifecycle.phase()).toBe("starting");
    expect(lifecycle.buffering()).toBe(true);
    expect(lifecycle.dispatches()).toBe(false);
    expect(spies.start).toHaveBeenCalledTimes(1);
  });

  test("a resolved start dispatches, and drains what was buffered", async () => {
    const { spies, lifecycle } = makeLifecycle({ start: vi.fn(() => Promise.resolve()) });
    lifecycle.send({ type: "CREATED" });
    await vi.waitFor(() => expect(lifecycle.phase()).toBe("ready"));
    expect(lifecycle.buffering()).toBe(false);
    expect(lifecycle.dispatches()).toBe(true);
    expect(spies.announceReady).toHaveBeenCalledTimes(1);
    expect(spies.drainBuffer).toHaveBeenCalledTimes(1);
  });

  test("a session that was never built has nothing to stop", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "CREATE_FAILED" });
    expect(lifecycle.phase()).toBe("ended");
    expect(spies.endSession).not.toHaveBeenCalled();
  });

  test("a close before the session was built has nothing to stop either", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "SOCKET_CLOSED" });
    expect(lifecycle.phase()).toBe("ended");
    expect(spies.endSession).not.toHaveBeenCalled();
  });
});

describe("the buffer is drained by ARRIVING and dropped by ENDING", () => {
  test("becoming ready drains — it does not drop first", async () => {
    // The first draft put `dropBuffer` on `starting`'s exit, and XState runs a
    // source state's exit actions BEFORE the target's entry ones — so every
    // pre-ready frame was discarded a moment before the drain replayed it.
    // Four ws-handler specs caught it; this is the direct statement.
    const { spies, lifecycle } = makeLifecycle({ start: vi.fn(() => Promise.resolve()) });
    lifecycle.send({ type: "CREATED" });
    await vi.waitFor(() => expect(spies.drainBuffer).toHaveBeenCalledTimes(1));
    expect(spies.dropBuffer).not.toHaveBeenCalled();
  });

  test("ending mid-start drops the frames unreplayed", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "CREATED" });
    lifecycle.send({ type: "SOCKET_CLOSED" });
    expect(spies.dropBuffer).toHaveBeenCalledTimes(1);
    expect(spies.drainBuffer).not.toHaveBeenCalled();
  });
});

describe("start() is an invoke, so a close deletes the staleness guard", () => {
  test("a close mid-start stops the session and never marks it ready", async () => {
    // What `if (!session) return` used to enforce by hand at the top of the
    // continuation. Leaving `starting` stops the actor, so the resolution
    // below is delivered to nothing.
    const gate = Promise.withResolvers<void>();
    const { spies, lifecycle } = makeLifecycle({ start: vi.fn(() => gate.promise) });
    lifecycle.send({ type: "CREATED" });
    lifecycle.send({ type: "SOCKET_CLOSED" });
    expect(spies.endSession).toHaveBeenCalledTimes(1);

    gate.resolve();
    await gate.promise;
    expect(spies.announceReady).not.toHaveBeenCalled();
    expect(spies.drainBuffer).not.toHaveBeenCalled();
    expect(lifecycle.phase()).toBe("ended");
  });

  test("a rejected start tears the session down, THEN tells the client", async () => {
    const calls: string[] = [];
    const { lifecycle } = makeLifecycle({
      start: vi.fn(() => Promise.reject(new Error("timed out"))),
      endSession: vi.fn(() => {
        calls.push("endSession");
      }),
      failClient: vi.fn(() => {
        calls.push("failClient");
      }),
    });
    lifecycle.send({ type: "CREATED" });
    await vi.waitFor(() => expect(calls).toEqual(["endSession", "failClient"]));
    expect(lifecycle.phase()).toBe("ended");
  });

  test("the close that follows a failed start does not stop the session twice", async () => {
    const { spies, lifecycle } = makeLifecycle({
      start: vi.fn(() => Promise.reject(new Error("timed out"))),
    });
    lifecycle.send({ type: "CREATED" });
    await vi.waitFor(() => expect(spies.endSession).toHaveBeenCalledTimes(1));
    lifecycle.send({ type: "SOCKET_CLOSED" });
    expect(spies.endSession).toHaveBeenCalledTimes(1);
  });

  test("a second close does not stop a ready session twice", async () => {
    const { spies, lifecycle } = makeLifecycle({ start: vi.fn(() => Promise.resolve()) });
    lifecycle.send({ type: "CREATED" });
    await vi.waitFor(() => expect(lifecycle.phase()).toBe("ready"));
    lifecycle.send({ type: "SOCKET_CLOSED" });
    lifecycle.send({ type: "SOCKET_CLOSED" });
    expect(spies.endSession).toHaveBeenCalledTimes(1);
  });
});
