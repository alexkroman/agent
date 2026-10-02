// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit specs for the AssemblyAI TTS socket lifecycle statechart.
 *
 * `assemblyai-reconnect.test.ts` and `assemblyai-cancel-race.test.ts` assert
 * these rules end-to-end through a fake socket; here a phase is one `send`
 * away. The window counts outstanding cancels rather than flagging one, its
 * acknowledgement deadline fires only for a cancel nothing answered, and a
 * reconnect that is left — by success, failure or close — delivers nothing
 * else. Virtual time.
 */

import { TTS_CANCEL_ACK_TIMEOUT_MS } from "@alexkroman1/aai/host-internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AssemblyAITtsLifecycleEffects,
  createAssemblyAITtsLifecycle,
} from "./assemblyai-lifecycle.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A deferred the spec settles, standing in for the replacement's open. */
function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A lifecycle over spied effects; the socket is open and replacements hang. */
function makeLifecycle() {
  const socket = { open: true };
  const opens: ReturnType<typeof deferred>[] = [];
  const signals: AbortSignal[] = [];
  const order: string[] = [];
  const spies = {
    socketOpen: vi.fn(() => socket.open),
    sendCancel: vi.fn(() => order.push("sendCancel")),
    replaceSocket: vi.fn((signal: AbortSignal) => {
      order.push("replaceSocket");
      signals.push(signal);
      const open = deferred();
      opens.push(open);
      return open.promise;
    }),
    adoptSocket: vi.fn(() => order.push("adoptSocket")),
    dropQueue: vi.fn(() => order.push("dropQueue")),
    reconnectFailed: vi.fn((_cause: unknown) => order.push("reconnectFailed")),
  } satisfies AssemblyAITtsLifecycleEffects;
  const lifecycle = createAssemblyAITtsLifecycle(spies);
  return { lifecycle, spies, socket, opens, signals, order };
}

describe("the cancel window", () => {
  test("open until a Cancel goes out, shut until it is acknowledged", () => {
    const { lifecycle, spies } = makeLifecycle();
    expect(lifecycle.phase()).toBe("open");
    expect(lifecycle.abandoned()).toBe(false);
    lifecycle.send({ type: "CANCEL" });
    expect(spies.sendCancel).toHaveBeenCalledTimes(1);
    expect(lifecycle.phase()).toBe("cancelling");
    expect(lifecycle.abandoned()).toBe(true);
    expect(lifecycle.queueing()).toBe(false);
    lifecycle.send({ type: "CANCELLED" });
    expect(lifecycle.phase()).toBe("open");
    expect(lifecycle.abandoned()).toBe(false);
  });

  test("two cancels need two acknowledgements; a stray one changes nothing", () => {
    const { lifecycle, spies } = makeLifecycle();
    lifecycle.send({ type: "CANCELLED" }); // stray, before any Cancel
    expect(lifecycle.phase()).toBe("open");
    lifecycle.send({ type: "CANCEL" });
    lifecycle.send({ type: "CANCEL" });
    expect(spies.sendCancel).toHaveBeenCalledTimes(2);
    lifecycle.send({ type: "CANCELLED" });
    expect(lifecycle.abandoned()).toBe(true);
    lifecycle.send({ type: "CANCELLED" });
    lifecycle.send({ type: "CANCELLED" }); // stray, after the last
    expect(lifecycle.abandoned()).toBe(false);
    // The count did not go negative: one Cancel shuts the window again.
    lifecycle.send({ type: "CANCEL" });
    expect(lifecycle.abandoned()).toBe(true);
  });

  test("an unanswered cancel replaces the socket at the deadline, once", async () => {
    const { lifecycle, spies } = makeLifecycle();
    lifecycle.send({ type: "CANCEL" });
    await vi.advanceTimersByTimeAsync(TTS_CANCEL_ACK_TIMEOUT_MS - 1);
    expect(spies.replaceSocket).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(spies.replaceSocket).toHaveBeenCalledTimes(1);
    expect(lifecycle.phase()).toBe("reconnecting");
    // The window lifts with the socket it was filtering.
    expect(lifecycle.abandoned()).toBe(false);
    await vi.advanceTimersByTimeAsync(TTS_CANCEL_ACK_TIMEOUT_MS * 2);
    expect(spies.replaceSocket).toHaveBeenCalledTimes(1);
  });

  test("an answered cancel, or a close, disarms the deadline", async () => {
    const answered = makeLifecycle();
    answered.lifecycle.send({ type: "CANCEL" });
    answered.lifecycle.send({ type: "CANCELLED" });
    const closed = makeLifecycle();
    closed.lifecycle.send({ type: "CANCEL" });
    closed.lifecycle.send({ type: "CANCEL" });
    closed.lifecycle.send({ type: "CLOSE" });
    expect(closed.lifecycle.phase()).toBe("closed");
    expect(closed.lifecycle.abandoned()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TTS_CANCEL_ACK_TIMEOUT_MS * 2);
    expect(answered.spies.replaceSocket).not.toHaveBeenCalled();
    expect(closed.spies.replaceSocket).not.toHaveBeenCalled();
  });

  test("a second cancel re-arms the deadline from its own send", async () => {
    const { lifecycle, spies } = makeLifecycle();
    lifecycle.send({ type: "CANCEL" });
    await vi.advanceTimersByTimeAsync(TTS_CANCEL_ACK_TIMEOUT_MS - 1);
    lifecycle.send({ type: "CANCEL" });
    await vi.advanceTimersByTimeAsync(TTS_CANCEL_ACK_TIMEOUT_MS - 1);
    expect(spies.replaceSocket).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(spies.replaceSocket).toHaveBeenCalledTimes(1);
  });
});

describe("the reconnect fallback", () => {
  test("a socket that cannot carry the Cancel is replaced without sending it", () => {
    const { lifecycle, spies, socket } = makeLifecycle();
    socket.open = false;
    lifecycle.send({ type: "CANCEL" });
    expect(spies.sendCancel).not.toHaveBeenCalled();
    expect(spies.replaceSocket).toHaveBeenCalledTimes(1);
    expect(lifecycle.phase()).toBe("reconnecting");
    expect(lifecycle.queueing()).toBe(true);
  });

  test("so is one that shuts mid-window, and the window lifts with it", () => {
    const { lifecycle, spies, socket } = makeLifecycle();
    lifecycle.send({ type: "CANCEL" });
    socket.open = false;
    lifecycle.send({ type: "CANCEL" });
    expect(spies.sendCancel).toHaveBeenCalledTimes(1);
    expect(lifecycle.phase()).toBe("reconnecting");
    expect(lifecycle.abandoned()).toBe(false);
  });

  test("a cancel while connecting drops the queue and starts nothing new", () => {
    const { lifecycle, spies, socket } = makeLifecycle();
    socket.open = false;
    lifecycle.send({ type: "CANCEL" });
    lifecycle.send({ type: "CANCEL" });
    expect(spies.dropQueue).toHaveBeenCalledTimes(1);
    expect(spies.replaceSocket).toHaveBeenCalledTimes(1);
    expect(lifecycle.phase()).toBe("reconnecting");
  });

  test("an opened replacement is adopted and the session is open again", async () => {
    const { lifecycle, spies, socket, opens } = makeLifecycle();
    socket.open = false;
    lifecycle.send({ type: "CANCEL" });
    opens[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(spies.adoptSocket).toHaveBeenCalledTimes(1);
    expect(lifecycle.phase()).toBe("open");
    expect(lifecycle.queueing()).toBe(false);
    expect(spies.reconnectFailed).not.toHaveBeenCalled();
  });

  test("a failed replacement drops the queue, then reports once", async () => {
    const { lifecycle, spies, socket, opens, order } = makeLifecycle();
    socket.open = false;
    lifecycle.send({ type: "CANCEL" });
    const cause = new Error("never opened");
    opens[0]?.reject(cause);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.phase()).toBe("failed");
    expect(lifecycle.queueing()).toBe(false);
    expect(order).toEqual(["replaceSocket", "dropQueue", "reconnectFailed"]);
    expect(spies.reconnectFailed).toHaveBeenCalledWith(cause);
    expect(spies.adoptSocket).not.toHaveBeenCalled();
  });

  test("failed is not terminal: the next barge-in tries a replacement again", async () => {
    const { lifecycle, spies, socket, opens } = makeLifecycle();
    socket.open = false;
    lifecycle.send({ type: "CANCEL" });
    opens[0]?.reject(new Error("never opened"));
    await vi.advanceTimersByTimeAsync(0);
    lifecycle.send({ type: "CANCEL" });
    expect(spies.replaceSocket).toHaveBeenCalledTimes(2);
    expect(lifecycle.phase()).toBe("reconnecting");
  });

  test("a close mid-reconnect aborts the wait and delivers neither outcome", async () => {
    // What the `ws !== next` identity checks used to stand in for.
    const { lifecycle, spies, socket, opens, signals } = makeLifecycle();
    socket.open = false;
    lifecycle.send({ type: "CANCEL" });
    lifecycle.send({ type: "CLOSE" });
    expect(signals[0]?.aborted).toBe(true);
    expect(lifecycle.queueing()).toBe(false);
    opens[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(spies.adoptSocket).not.toHaveBeenCalled();
    expect(spies.reconnectFailed).not.toHaveBeenCalled();
    expect(lifecycle.phase()).toBe("closed");
  });

  test("nothing reopens a closed lifecycle", () => {
    const { lifecycle, spies } = makeLifecycle();
    lifecycle.send({ type: "CLOSE" });
    lifecycle.send({ type: "CANCEL" });
    lifecycle.send({ type: "CANCELLED" });
    expect(spies.sendCancel).not.toHaveBeenCalled();
    expect(spies.replaceSocket).not.toHaveBeenCalled();
    expect(lifecycle.phase()).toBe("closed");
  });
});
