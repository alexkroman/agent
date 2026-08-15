// Copyright 2026 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WS_OPEN_TIMEOUT_MS } from "../_socket.ts";
import { openRime, type RimeSession } from "./rime.ts";

type WsEvent = "open" | "message" | "error" | "close";
type WsListener = (...args: unknown[]) => void;

const { FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: FakeWebSocket[] = [];
    /** When true, new sockets black-hole: no "open", no "error" — ever. */
    static neverOpen = false;

    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    readonly url: string;
    readonly options: { perMessageDeflate?: boolean } | undefined;
    private readonly listeners = new Map<string, WsListener[]>();

    constructor(url: string, opts?: { perMessageDeflate?: boolean }) {
      this.url = url;
      this.options = opts;
      FakeWebSocket.instances.push(this);
      // Real `ws` fires "open" asynchronously; match that timing.
      if (!FakeWebSocket.neverOpen) queueMicrotask(() => this._fire("open"));
    }

    on(event: string, fn: WsListener) {
      const arr = this.listeners.get(event) ?? [];
      arr.push(fn);
      this.listeners.set(event, arr);
    }

    once(event: string, fn: WsListener) {
      const wrapper = (...args: unknown[]) => {
        this.removeListener(event, wrapper);
        fn(...args);
      };
      this.on(event, wrapper);
    }

    removeListener(event: string, fn: WsListener) {
      const arr = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        arr.filter((l) => l !== fn),
      );
    }

    off(event: string, fn: WsListener) {
      this.removeListener(event, fn);
    }

    removeAllListeners() {
      this.listeners.clear();
    }

    listenerCount() {
      let n = 0;
      for (const arr of this.listeners.values()) n += arr.length;
      return n;
    }

    send(data: string) {
      this.sent.push(data);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this._fire("close");
    }

    _fire(event: WsEvent, ...args: unknown[]) {
      for (const fn of this.listeners.get(event) ?? []) fn(...args);
    }

    _msg(payload: unknown) {
      this._fire("message", JSON.stringify(payload));
    }
  }

  return { FakeWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
  WebSocket: FakeWebSocket,
}));

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  FakeWebSocket.neverOpen = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function openSession(apiKey = "test-key"): Promise<{
  session: RimeSession;
  ws: InstanceType<typeof FakeWebSocket>;
  controller: AbortController;
}> {
  const opener = openRime({ voice: "cove" });
  const controller = new AbortController();

  const openPromise = opener.open({
    sampleRate: 16_000,
    apiKey,
    signal: controller.signal,
  }) as Promise<RimeSession>;

  // Let the queued microtask that fires "open" run.
  await Promise.resolve();

  const session = await openPromise;
  // biome-ignore lint/style/noNonNullAssertion: at(-1) is always set after open() resolves
  const ws = FakeWebSocket.instances.at(-1)!;
  return { session, ws, controller };
}

describe("rime TTS adapter", () => {
  test("openRime returns an opener with name 'rime'", () => {
    const opener = openRime({ voice: "cove" });
    expect(opener.name).toBe("rime");
  });

  test("opens with permessage-deflate disabled", async () => {
    // `ws` defaults this to true on CLIENTS, and a provider that accepts the
    // offer costs a zlib context per socket (+321 KiB RSS, ~4.5x CPU, measured)
    // to compress PCM16, which does not compress. See PROVIDER_WS_OPTIONS.
    const { ws } = await openSession();
    expect(ws.options?.perMessageDeflate).toBe(false);
  });

  test("open() throws tts_auth_failed when API key is missing", async () => {
    const opener = openRime({ voice: "cove" });
    const controller = new AbortController();

    const openPromise = opener.open({
      sampleRate: 16_000,
      apiKey: "",
      signal: controller.signal,
    });

    await expect(openPromise).rejects.toMatchObject({ code: "tts_auth_failed" });
  });

  test("an initial connect that black-holes fails the open instead of hanging forever", async () => {
    // A dropped SYN or a stalled proxy emits neither "open" nor "error". With
    // no deadline `waitForOpen` never settled, so `providers.open()` never
    // resolved: the ws-handler rejected the SESSION at its own timeout without
    // cancelling this connect, leaving the socket held by a pending listener
    // with no owner.
    FakeWebSocket.neverOpen = true;
    const controller = new AbortController();
    const openPromise = openRime({ voice: "cove" }).open({
      sampleRate: 16_000,
      apiKey: "test-key",
      signal: controller.signal,
    });
    // Assert on the rejection BEFORE advancing: the timer settles the promise
    // inside `advanceTimersByTimeAsync`, and a rejection with no handler yet
    // attached is an unhandled rejection the runner reports.
    const rejected = expect(openPromise).rejects.toMatchObject({ code: "tts_connect_failed" });

    await vi.advanceTimersByTimeAsync(WS_OPEN_TIMEOUT_MS + 1);

    await rejected;
    expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("an abort during the connect abandons the socket rather than waiting it out", async () => {
    // `closeOnAbort` is registered only AFTER the connect resolves, so before
    // this the session's own hang-up could not reach a socket still connecting.
    FakeWebSocket.neverOpen = true;
    const controller = new AbortController();
    const openPromise = openRime({ voice: "cove" }).open({
      sampleRate: 16_000,
      apiKey: "test-key",
      signal: controller.signal,
    });

    controller.abort();

    await expect(openPromise).rejects.toMatchObject({ code: "tts_connect_failed" });
    expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("a throwing audio listener cannot escape the socket's message handler", async () => {
    // Emitting straight off the emitter let a downstream throw escape into
    // Node's EventEmitter as an uncaughtException, taking down a multi-tenant
    // host rather than one session. `shell.emit` owns the containment.
    const { session, ws } = await openSession();
    const listener = vi.fn(() => {
      throw new Error("listener blew up");
    });
    session.on("audio", listener);
    const samples = new Int16Array([1, 2]);
    const base64 = Buffer.from(samples.buffer).toString("base64");

    expect(() => ws._msg({ type: "chunk", data: base64, contextId: null })).not.toThrow();
    // The event really fired — otherwise the assertion above is vacuous.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a throwing error listener cannot escape the socket's message handler", async () => {
    const { session, ws } = await openSession();
    const listener = vi.fn(() => {
      throw new Error("listener blew up");
    });
    session.on("error", listener);

    expect(() => ws._msg({ type: "error", message: "upstream said no" })).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("incoming chunk message emits audio as Int16Array", async () => {
    const { session, ws } = await openSession();

    const audioEvents: Int16Array[] = [];
    session.on("audio", (pcm) => audioEvents.push(pcm));

    const samples = new Int16Array([100, 200, 300, 400]);
    const base64 = Buffer.from(samples.buffer).toString("base64");

    ws._msg({ type: "chunk", data: base64, contextId: null });

    expect(audioEvents.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: length was asserted to be 1 above
    const pcm = audioEvents[0]!;
    expect(pcm).toBeInstanceOf(Int16Array);
    expect(pcm.length).toBe(4);
    expect(pcm[0]).toBe(100);
    expect(pcm[3]).toBe(400);
  });

  test("sendText forwards the text as a JSON {text} frame", async () => {
    const { session, ws } = await openSession();

    session.sendText("Hello, world!");

    expect(ws.sent).toContain(JSON.stringify({ text: "Hello, world!" }));
  });

  test("flush() sends a trailing '.' and emits done after quiescence post-audio", async () => {
    const { session, ws } = await openSession();

    const doneEvents: number[] = [];
    session.on("done", () => doneEvents.push(Date.now()));

    session.sendText("Hi there");
    session.flush();

    // Trailing punctuation forces Rime to synthesize the buffer without
    // closing the WS (which `eos` would do).
    expect(ws.sent).toContain(JSON.stringify({ text: "." }));

    // First-audio timer is 5s — short window must not fire `done` yet.
    vi.advanceTimersByTime(500);
    expect(doneEvents.length).toBe(0);

    // First chunk arrives, switching to the short quiescence window.
    const samples = new Int16Array([100, 200, 300, 400]);
    ws._msg({
      type: "chunk",
      data: Buffer.from(samples.buffer).toString("base64"),
      contextId: null,
    });

    vi.advanceTimersByTime(499);
    expect(doneEvents.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(doneEvents.length).toBe(1);
  });

  test("flush() falls back to first-audio timeout when no chunk arrives", async () => {
    const { session } = await openSession();

    const doneEvents: number[] = [];
    session.on("done", () => doneEvents.push(Date.now()));

    session.sendText("Hi there");
    session.flush();

    // No chunk arrives — must wait the full FIRST_AUDIO_TIMEOUT_MS (5s).
    vi.advanceTimersByTime(4999);
    expect(doneEvents.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(doneEvents.length).toBe(1);
  });

  test("cancel() sends clear operation and emits done synchronously", async () => {
    const { session, ws } = await openSession();

    const doneEvents: number[] = [];
    session.on("done", () => doneEvents.push(Date.now()));

    session.sendText("Hello");
    // Barge-in cannot be deferred — `done` must fire synchronously.
    session.cancel();

    expect(ws.sent).toContain(JSON.stringify({ operation: "clear" }));
    expect(doneEvents.length).toBe(1);
  });

  test("cancel() clears pending timers so no stale done leaks into the next turn", async () => {
    const { session } = await openSession();

    const doneEvents: number[] = [];
    session.on("done", () => doneEvents.push(doneEvents.length));

    // Turn 1 flushes (arming the first-audio timer), then is barged in.
    session.sendText("turn one");
    session.flush();
    session.cancel();
    expect(doneEvents.length).toBe(1); // cancel's own synchronous done

    // Turn 2 begins. Turn 1's timer must have been cleared by cancel() —
    // if it survived, it would fire here and end turn 2's flush-wait early
    // (TtsEvents contract: done never fires for a cancelled turn).
    session.sendText("turn two");
    vi.advanceTimersByTime(10_000);
    expect(doneEvents.length).toBe(1);

    // Turn 2's own flush still completes normally.
    session.flush();
    vi.advanceTimersByTime(5000);
    expect(doneEvents.length).toBe(2);
  });

  test("close() closes the WebSocket and is idempotent", async () => {
    const { session, ws } = await openSession();

    expect(ws.readyState).toBe(FakeWebSocket.OPEN);

    await session.close();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);

    await expect(session.close()).resolves.toBeUndefined();
  });

  test("close() drops the session listeners but leaves a no-op error guard", async () => {
    const { session, ws } = await openSession();
    expect(ws.listenerCount()).toBeGreaterThan(1);
    await session.close();
    // The session's message/close/error handlers are gone; only a single
    // no-op `error` guard remains so a late error during the close handshake
    // can't crash the process.
    expect(ws.listenerCount()).toBe(1);
    expect(() => ws._fire("error", new Error("late reset"))).not.toThrow();
  });
});
