// Copyright 2026 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openRime, type RimeSession } from "./rime.ts";

type WsEvent = "open" | "message" | "error" | "close";
type WsListener = (...args: unknown[]) => void;

const { FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    readonly url: string;
    private readonly listeners = new Map<string, WsListener[]>();

    constructor(url: string, _opts?: unknown) {
      this.url = url;
      FakeWebSocket.instances.push(this);
      // Real `ws` fires "open" asynchronously; match that timing.
      queueMicrotask(() => this._fire("open"));
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
});
