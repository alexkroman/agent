// Copyright 2026 the AAI authors. MIT license.
/** Unit test for the Rime TTS adapter. Mocks the `ws` package. */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openRime, type RimeSession } from "./rime.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Fake WebSocket — hoisted so `vi.mock` factory can reference it
// ──────────────────────────────────────────────────────────────────────────────

type WsEvent = "open" | "message" | "error" | "close";
type WsListener = (...args: unknown[]) => void;

const { FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    private readonly listeners = new Map<string, WsListener[]>();

    static instances: FakeWebSocket[] = [];

    readonly url: string;

    constructor(url: string, _opts?: unknown) {
      this.url = url;
      FakeWebSocket.instances.push(this);
      // Simulate async open on next microtask (matches real ws behaviour).
      queueMicrotask(() => this._fire("open"));
    }

    on(event: string, fn: WsListener) {
      const arr = this.listeners.get(event) ?? [];
      arr.push(fn);
      this.listeners.set(event, arr);
    }

    once(event: string, fn: WsListener) {
      const wrapper = (...args: unknown[]) => {
        this.off(event, wrapper);
        fn(...args);
      };
      this.on(event, wrapper);
    }

    removeListener(event: string, fn: WsListener) {
      this.off(event, fn);
    }

    private off(event: string, fn: WsListener) {
      const arr = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        arr.filter((l) => l !== fn),
      );
    }

    send(data: string) {
      this.sent.push(data);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this._fire("close");
    }

    /** Test helper: fire an event on this socket. */
    _fire(event: WsEvent, ...args: unknown[]) {
      for (const fn of this.listeners.get(event) ?? []) fn(...args);
    }

    /** Test helper: simulate a JSON message from the server. */
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

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

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

  // Let the microtask that fires FakeWebSocket "open" run.
  await Promise.resolve();

  const session = await openPromise;
  // biome-ignore lint/style/noNonNullAssertion: at(-1) is always set after open() resolves
  const ws = FakeWebSocket.instances.at(-1)!;
  return { session, ws, controller };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

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

    // Encode 4 PCM16 samples (8 bytes) as base64.
    const samples = new Int16Array([100, 200, 300, 400]);
    const base64 = Buffer.from(samples.buffer).toString("base64");

    ws._msg({ type: "chunk", data: base64, contextId: null });

    expect(audioEvents.length).toBe(1);
    const firstChunk = audioEvents[0];
    expect(firstChunk).toBeInstanceOf(Int16Array);
    // Each sample pair decodes correctly.
    // biome-ignore lint/style/noNonNullAssertion: length was asserted to be 1 on the line above
    const pcm = firstChunk!;
    expect(pcm.length).toBe(4);
    expect(pcm[0]).toBe(100);
    expect(pcm[3]).toBe(400);
  });

  test("sendText forwards the text as a WebSocket string message", async () => {
    const { session, ws } = await openSession();

    session.sendText("Hello, world!");

    expect(ws.sent).toContain("Hello, world!");
  });

  test("flush() sends <EOS> and emits done after quiescence timer", async () => {
    const { session, ws } = await openSession();

    const doneEvents: number[] = [];
    session.on("done", () => doneEvents.push(Date.now()));

    session.sendText("Hi there");
    session.flush();

    // <EOS> should have been sent.
    expect(ws.sent).toContain("<EOS>");

    // `done` is NOT emitted immediately — the quiescence timer must fire.
    expect(doneEvents.length).toBe(0);

    // Advance fake timers by 500 ms (quiescence timeout).
    vi.advanceTimersByTime(500);

    expect(doneEvents.length).toBe(1);
  });

  test("cancel() sends <CLEAR> and emits done synchronously", async () => {
    const { session, ws } = await openSession();

    const doneEvents: number[] = [];
    session.on("done", () => doneEvents.push(Date.now()));

    session.sendText("Hello");
    // cancel() must emit `done` synchronously — barge-in cannot be deferred.
    session.cancel();

    expect(ws.sent).toContain("<CLEAR>");
    // done was emitted synchronously (before any await / timer).
    expect(doneEvents.length).toBe(1);
  });

  test("close() closes the WebSocket and is idempotent", async () => {
    const { session, ws } = await openSession();

    expect(ws.readyState).toBe(FakeWebSocket.OPEN);

    await session.close();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);

    // Second close should not throw.
    await expect(session.close()).resolves.toBeUndefined();
  });
});
