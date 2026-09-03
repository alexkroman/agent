// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest's end of the platform socket.
 *
 * What is worth pinning here is the FAILURE taxonomy, because it is the whole
 * safety argument for preferring a socket at all (`platform-socket.ts`'s module
 * doc): a call that was never written may be re-sent over HTTP, and a call that
 * WAS written may not — re-sending one would run an `appendEvents` twice. Those
 * two cases are one `if` apart in the implementation and indistinguishable from
 * the caller unless the codes are right, so each has a case here.
 *
 * The other half is the half-open socket. A WebSocket that is black-holed stays
 * `OPEN` forever, so without the heartbeat every call on it burns its own
 * deadline and the socket never recovers; the timers are virtual here for the
 * reason `packages/aai/CLAUDE.md` gives about specs that observe one.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { HeaderWebSocket } from "./_ws.ts";
import { PLATFORM_ROUTES } from "./platform-endpoint.ts";
import {
  createPlatformSocket,
  HEARTBEAT_MS,
  isPlatformSocketUnavailable,
  PONG_DEADLINE_MS,
  platformSocketUrl,
} from "./platform-socket.ts";
import {
  closePlatformSockets,
  ensurePlatformSocket,
  platformSocketFor,
} from "./platform-socket-registry.ts";
import { PLATFORM_UNAVAILABLE_CODE } from "./workflow-api-error-status.ts";

const BASE = "https://api.test/my-agent";
const TOKEN = "sandbox-bearer";

const CALL = {
  route: PLATFORM_ROUTES.sessionState,
  body: JSON.stringify({ method: "load" }),
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
};

/** A `ws`-shaped socket a spec drives by hand. */
function fakeSocket() {
  // `data` is REQUIRED, because the message overload declares it so and a
  // listener taking an optional one is not assignable to that slot.
  type Listener = (event: { data: unknown; code?: number; message?: string }) => void;
  const listeners = new Map<string, Listener[]>();
  const sent: string[] = [];
  let readyState = 0;
  let sendThrows = false;
  // Typed as the real seam rather than cast into it: a cast would stop reporting
  // the moment `HeaderWebSocket` grows a member, which is the failure
  // `AGENTS.md` records for `as unknown as`.
  const socket: HeaderWebSocket = {
    get readyState(): number {
      return readyState;
    },
    send(data: string): void {
      if (sendThrows) throw new Error("EPIPE");
      sent.push(data);
    },
    close(): void {
      readyState = 3;
    },
    addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  const emit = (type: string, event: { data: unknown; code?: number }): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    socket,
    sent,
    headers: {} as Record<string, string>,
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
      emit("close", { code, data: undefined });
    },
    /** The next write throws — a socket the OS has already torn down. */
    breakSend(): void {
      sendThrows = true;
    },
    /** What the peer read, as frames. */
    frames(): Record<string, unknown>[] {
      return sent.map((text) => JSON.parse(text) as Record<string, unknown>);
    },
  };
}

/** One socket over one fake peer, opened and ready to answer. */
function openSocket() {
  const peer = fakeSocket();
  const sockets: ReturnType<typeof fakeSocket>[] = [peer];
  const socket = createPlatformSocket({
    base: BASE,
    token: TOKEN,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    create: (_url, opts) => {
      const next = sockets.at(-1);
      if (next === undefined) throw new Error("no fake socket left");
      Object.assign(next.headers, opts.headers);
      return next.socket;
    },
  });
  peer.open();
  return { socket, peer, sockets };
}

afterEach(() => {
  closePlatformSockets();
  vi.useRealTimers();
});

describe("what crosses to the platform", () => {
  test("dials the socket path with a wss scheme and the bearer on the handshake", () => {
    const { peer } = openSocket();
    expect(platformSocketUrl(BASE)).toBe("wss://api.test/my-agent/platform-socket");
    // Never a query parameter: Modal's proxy logs URLs and this token authorizes
    // every one of the agent's platform routes.
    expect(peer.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("frames the route, the body and the trace, and answers with the reply's status", async () => {
    const { socket, peer } = openSocket();
    const answered = socket.send(CALL);
    const [frame] = peer.frames();
    expect(frame).toMatchObject({
      t: "req",
      route: PLATFORM_ROUTES.sessionState,
      body: CALL.body,
      traceparent: CALL.traceparent,
    });
    peer.deliver({ t: "res", id: frame?.id, status: 200, body: '{"result":null}' });
    await expect(answered).resolves.toEqual({ status: 200, body: '{"result":null}' });
  });

  test("carries several calls at once and matches each reply to its own", async () => {
    const { socket, peer } = openSocket();
    const first = socket.send({ ...CALL, body: '{"method":"load"}' });
    const second = socket.send({ ...CALL, body: '{"method":"commit"}' });
    const [a, b] = peer.frames();
    // Answered out of order, which is the whole reason a frame carries an id.
    peer.deliver({ t: "res", id: b?.id, status: 200, body: "second" });
    peer.deliver({ t: "res", id: a?.id, status: 200, body: "first" });
    await expect(first).resolves.toMatchObject({ body: "first" });
    await expect(second).resolves.toMatchObject({ body: "second" });
  });

  test("hands a non-2xx back as a status rather than throwing", async () => {
    // The whole point of a status-carrying reply frame: every caller's `errorFor`
    // and `RETRYABLE_STATUS` reading happens above this, unchanged.
    const { socket, peer } = openSocket();
    const answered = socket.send(CALL);
    peer.deliver({ t: "res", id: peer.frames()[0]?.id, status: 409, body: "taken" });
    await expect(answered).resolves.toEqual({ status: 409, body: "taken" });
  });
});

describe("a call that was never written may be retried; one that was may not", () => {
  test("refuses before the socket is open, so the caller may use HTTP", async () => {
    const peer = fakeSocket();
    const socket = createPlatformSocket({
      base: BASE,
      token: TOKEN,
      create: () => peer.socket,
    });
    expect(socket.isOpen()).toBe(false);
    await expect(socket.send(CALL)).rejects.toSatisfy(isPlatformSocketUnavailable);
    expect(peer.sent).toHaveLength(0);
  });

  test("a socket that dies with the call in flight is RETRYABLE, not a refusal", async () => {
    const { socket, peer } = openSocket();
    const answered = socket.send(CALL);
    expect(peer.sent).toHaveLength(1);
    peer.fail(1006);
    const err = await answered.catch((e: unknown) => e);
    // Coded like a 503 so the engine's own retry decides — and NOT as a refusal,
    // because the platform may already have run it.
    expect(isPlatformSocketUnavailable(err)).toBe(false);
    expect(err).toMatchObject({ code: PLATFORM_UNAVAILABLE_CODE });
  });

  test("a write that throws is a refusal, because nothing reached the platform", async () => {
    const { socket, peer } = openSocket();
    peer.breakSend();
    await expect(socket.send(CALL)).rejects.toSatisfy(isPlatformSocketUnavailable);
  });
});

describe("a half-open socket is torn down rather than answered", () => {
  test("pings on the heartbeat and stays open when the pong comes back", () => {
    vi.useFakeTimers();
    const { socket, peer } = openSocket();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    const ping = peer.frames().at(-1);
    expect(ping).toMatchObject({ t: "ping" });
    peer.deliver({ t: "pong", id: ping?.id });
    vi.advanceTimersByTime(PONG_DEADLINE_MS);
    expect(socket.isOpen()).toBe(true);
  });

  test("drops the socket when a pong does not come back, failing the calls on it", async () => {
    vi.useFakeTimers();
    const { socket, peer } = openSocket();
    const answered = socket.send(CALL);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(peer.frames().at(-1)).toMatchObject({ t: "ping" });
    // No pong. Without this the socket reads OPEN forever and every later call
    // spends its own deadline on a peer that is gone.
    vi.advanceTimersByTime(PONG_DEADLINE_MS);
    expect(socket.isOpen()).toBe(false);
    await expect(answered).rejects.toThrow(/in flight/);
  });

  test("gives up on a call nothing ever answered, rather than leaking its slot", async () => {
    // A caller's own deadline fails the CALL and cannot reach into the pending
    // map; without the sweep a platform that answers pings while wedging one
    // route loses a slot per timed-out call until the cap refuses everything.
    vi.useFakeTimers();
    const { socket, peer } = openSocket();
    const answered = socket.send(CALL);
    // Answer every ping, so the socket stays healthy and only the CALL is stuck.
    for (let elapsed = 0; elapsed < 70_000; elapsed += HEARTBEAT_MS) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      const ping = peer.frames().at(-1);
      if (ping?.t === "ping") peer.deliver({ t: "pong", id: ping.id });
    }
    await expect(answered).rejects.toThrow(/never answered/);
    expect(socket.isOpen()).toBe(true);
  });

  test("reconnects after a close, and the new socket serves calls", async () => {
    vi.useFakeTimers();
    const { socket, peer, sockets } = openSocket();
    peer.fail(1006);
    expect(socket.isOpen()).toBe(false);
    const replacement = fakeSocket();
    sockets.push(replacement);
    // The backoff is jittered, so advance past its whole first window.
    vi.advanceTimersByTime(HEARTBEAT_MS);
    replacement.open();
    expect(socket.isOpen()).toBe(true);
    const answered = socket.send(CALL);
    replacement.deliver({ t: "res", id: replacement.frames()[0]?.id, status: 200, body: "ok" });
    await expect(answered).resolves.toMatchObject({ status: 200 });
  });

  test("a closed socket stops reconnecting", () => {
    vi.useFakeTimers();
    const { socket, peer, sockets } = openSocket();
    socket.close();
    peer.fail(1006);
    sockets.push(fakeSocket());
    vi.advanceTimersByTime(HEARTBEAT_MS * 10);
    expect(socket.isOpen()).toBe(false);
  });
});

describe("frames this build does not understand", () => {
  test("drops an unreadable frame rather than closing the socket", () => {
    // Forwards compatibility: a newer platform adding a frame kind must not take
    // every guest offline. See `parsePlatformFrame`.
    const { socket, peer } = openSocket();
    peer.deliverRaw("not json");
    peer.deliver({ t: "something-new", id: 1 });
    expect(socket.isOpen()).toBe(true);
  });

  test("drops a reply nothing is waiting for", async () => {
    const { socket, peer } = openSocket();
    peer.deliver({ t: "res", id: 9999, status: 200, body: "stray" });
    const answered = socket.send(CALL);
    peer.deliver({ t: "res", id: peer.frames().at(-1)?.id, status: 200, body: "mine" });
    await expect(answered).resolves.toMatchObject({ body: "mine" });
  });
});

describe("the registry is what a caller consults", () => {
  test("is empty until something opens one, so nothing dials by accident", () => {
    // The property that keeps a unit test off the network: only
    // `installWorkflowSupport` calls `ensurePlatformSocket`.
    expect(platformSocketFor({ base: BASE, token: TOKEN })).toBeUndefined();
  });

  test("hands back one socket per base, and closes them all", () => {
    const peer = fakeSocket();
    const first = ensurePlatformSocket({ base: BASE, token: TOKEN }, { create: () => peer.socket });
    const second = ensurePlatformSocket(
      { base: BASE, token: TOKEN },
      { create: () => peer.socket },
    );
    expect(second).toBe(first);
    peer.open();
    expect(platformSocketFor({ base: BASE, token: TOKEN })).toBe(first);
    closePlatformSockets();
    expect(platformSocketFor({ base: BASE, token: TOKEN })).toBeUndefined();
  });

  test("a socket that is not open is not offered", () => {
    const peer = fakeSocket();
    ensurePlatformSocket({ base: BASE, token: TOKEN }, { create: () => peer.socket });
    expect(platformSocketFor({ base: BASE, token: TOKEN })).toBeUndefined();
  });
});
