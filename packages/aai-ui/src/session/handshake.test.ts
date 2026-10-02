// Copyright 2026 the AAI authors. MIT license.
/**
 * The handshake deadline — a socket that opened but never became a session.
 *
 * Two halves. The guard on its own, over virtual time, for what it decides
 * without a reconnecting socket: when it fires, what disarms it, and that a
 * socket with no reconnect machinery gives up at once. Then the deadline as
 * the session lives it over partysocket's real reconnecting socket (moved from
 * `reconnect.test.ts`): the re-dial, the bound, the CONSECUTIVE budget.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAudioMocks } from "../_react-test-utils.ts";
import { MockWebSocket, makeConfig, resetLastSocket } from "../_session-core-test-utils.ts";
import { createBrowserSession } from "./browser-session.ts";
import { createHandshakeGuard, HANDSHAKE_ERROR } from "./handshake.ts";
import type { BrowserSession } from "./types.ts";

/** Every socket partysocket constructed, in order. */
let created: MockWebSocket[] = [];

class TrackingWebSocket extends MockWebSocket {
  constructor(url: string) {
    super(url);
    created.push(this);
  }
}

/**
 * Advance fake time in small steps until partysocket constructs the next
 * socket (backoff caps at 15s), returning it. Small steps keep each new
 * socket young enough to close before partysocket's 4s connection timeout
 * fires — so every close in these tests is the one the test performs.
 */
async function waitForNextSocket(prevCount: number): Promise<MockWebSocket> {
  for (let i = 0; i < 40 && created.length === prevCount; i++) {
    await vi.advanceTimersByTimeAsync(500);
  }
  const socket = created.at(-1);
  if (created.length === prevCount || !socket) {
    throw new Error("no reconnect attempt within 20s of fake time");
  }
  return socket;
}

describe("createHandshakeGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A guard over a socket with NO reconnect machinery (an injected WebSocket). */
  function guard() {
    const controller = new AbortController();
    const onRetry = vi.fn();
    const onExhausted = vi.fn();
    const g = createHandshakeGuard({
      socket: {},
      signal: controller.signal,
      onRetry,
      onExhausted,
    });
    return { g, controller, onRetry, onExhausted };
  }

  it("fires ten seconds after an attempt opens, and not before", async () => {
    const { g, onExhausted } = guard();
    g.arm();
    await vi.advanceTimersByTimeAsync(9999);
    expect(onExhausted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onExhausted).toHaveBeenCalledOnce();
  });

  it("a socket that cannot re-dial is exhausted on the first timeout", async () => {
    const { g, onRetry, onExhausted } = guard();
    g.arm();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onExhausted).toHaveBeenCalledOnce();
  });

  it("re-arming restarts the deadline rather than stacking a second", async () => {
    const { g, onExhausted } = guard();
    g.arm();
    await vi.advanceTimersByTimeAsync(6000);
    g.arm();
    await vi.advanceTimersByTimeAsync(6000);
    expect(onExhausted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(onExhausted).toHaveBeenCalledOnce();
  });

  it.each([
    ["disarm()", (g: ReturnType<typeof guard>) => g.g.disarm()],
    ["succeeded()", (g: ReturnType<typeof guard>) => g.g.succeeded()],
    ["the teardown signal", (g: ReturnType<typeof guard>) => g.controller.abort()],
  ])("%s stops an armed deadline", async (_label, stop) => {
    const g = guard();
    g.g.arm();
    stop(g);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(g.onExhausted).not.toHaveBeenCalled();
  });

  it("reports a connection error the statechart may recover from", () => {
    expect(HANDSHAKE_ERROR).toMatchObject({ code: "connection", fatal: false });
  });
});

// A completed WebSocket handshake is not a session. The server builds the
// session synchronously from its own upgrade callback and sends `config` at
// zero RTT, so an open socket with nothing on it means the peer is not a
// healthy agent server — a tunnel answering the 101 while the guest behind it
// is wedged. partysocket cannot see this: its connectionTimeout is cleared
// the instant `open` fires. Untreated, the session reached "ready" — the same
// live indicator the UI paints for "listening" — and stayed there forever,
// with no mic (no `config` means no initAudioCapture), no error and no retry.
describe("session-core handshake deadline", () => {
  let core: BrowserSession;
  let audio: ReturnType<typeof installAudioMocks>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetLastSocket();
    created = [];
    // The healthy case below receives a real `config`, which starts the audio
    // path — without the mocks it would fail on getUserMedia and error for a
    // reason that has nothing to do with the handshake.
    audio = installAudioMocks();
    vi.stubGlobal("WebSocket", TrackingWebSocket);
    core = createBrowserSession({ platformUrl: "ws://localhost:3000" });
  });

  afterEach(() => {
    core.disconnect();
    audio.restore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-dials a peer that opens the socket and never sends config", async () => {
    core.connect();
    await vi.advanceTimersByTimeAsync(0);
    created[0]?.simulateOpen();
    expect(core.getSnapshot().state).toBe("ready");

    // Nothing arrives. The deadline turns an apparently-healthy socket into a
    // failed attempt — the sandbox behind the endpoint may have been
    // replaced, and the next attempt re-brokers.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(core.getSnapshot().state).toBe("connecting");
    const socket = await waitForNextSocket(1);
    // `waitForNextSocket` throws when no attempt arrives, so `toBeDefined()`
    // here was unreachable as a failure while reading as if the re-dial were
    // being verified. What the re-dial owes is a SECOND, DISTINCT socket: the
    // URL provider is re-evaluated per attempt, which is what lands the next
    // one on a replacement sandbox rather than the wedged peer.
    expect(created).toHaveLength(2);
    expect(socket).not.toBe(created[0]);
  });

  it("gives up with a real error rather than re-dialing a wedged peer forever", async () => {
    core.connect();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4 && core.getSnapshot().state !== "error"; i++) {
      created.at(-1)?.simulateOpen();
      await vi.advanceTimersByTimeAsync(10_000);
      if (core.getSnapshot().state === "error") break;
      await waitForNextSocket(created.length);
    }

    expect(core.getSnapshot().state).toBe("error");
    expect(core.getSnapshot().error?.code).toBe("connection");
    // Bounded: forceReconnect restarts partysocket's own budget, so without a
    // cap of our own a wedged peer would be re-dialed every ~10s forever.
    const settled = created.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(created).toHaveLength(settled);
  });

  it("the budget is CONSECUTIVE — a completed handshake between timeouts spends nothing", async () => {
    // One guard covers a whole connect(), partysocket's retries included, so a
    // count that survived a successful handshake was per-CONNECTION rather than
    // consecutive: three drops across an hour-long call, each timing out once
    // before the next attempt answered, surfaced the permanent
    // "did not complete the session handshake" error against a healthy peer.
    core.connect();
    await vi.advanceTimersByTimeAsync(0);

    // One timeout, then a peer that answers properly.
    created[0]?.simulateOpen();
    await vi.advanceTimersByTimeAsync(10_000);
    const healthy = await waitForNextSocket(1);
    healthy.simulateOpen();
    healthy.simulateMessage(makeConfig());
    expect(core.getSnapshot().state).not.toBe("error");

    // The session drops later and the next two attempts time out. Counted from
    // the connection rather than consecutively that is the third strike and the
    // session dies; counted consecutively it is the second, so it re-dials.
    healthy.simulateClose();
    for (let i = 0; i < 2; i++) {
      const socket = await waitForNextSocket(created.length);
      socket.simulateOpen();
      await vi.advanceTimersByTimeAsync(10_000);
    }

    expect(core.getSnapshot().state).toBe("connecting");
    expect(core.getSnapshot().error).toBeNull();
  });

  it("a config frame disarms the deadline, so a healthy session is left alone", async () => {
    core.connect();
    await vi.advanceTimersByTimeAsync(0);
    created[0]?.simulateOpen();
    created[0]?.simulateMessage(makeConfig());

    await vi.advanceTimersByTimeAsync(60_000);
    expect(core.getSnapshot().state).not.toBe("error");
    expect(created).toHaveLength(1);
  });
});
