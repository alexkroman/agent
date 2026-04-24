// Copyright 2026 the AAI authors. MIT license.
/** Unit test for the Deepgram STT adapter (mocked SDK). */

import { describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
import { type DeepgramSession, openDeepgram } from "./deepgram.ts";

// ---------------------------------------------------------------------------
// Mock the `@deepgram/sdk` so no real sockets are opened.
//
// Each fake `V1Socket` keeps one listener per event (matching the real SDK's
// `on()` which replaces rather than appends) and exposes `_fire(event, data)`
// for tests to inject events. The adapter's `open()` returns a
// `DeepgramSession` with a `_connection` pointer (which in tests is the fake)
// giving the test a handle to `_fire`.
// ---------------------------------------------------------------------------

interface FakeSocket {
  on(ev: string, fn: (...args: unknown[]) => void): void;
  connect(): FakeSocket;
  waitForOpen(): Promise<void>;
  close(): void;
  sendMedia(_data: ArrayBufferView): void;
  _fire(ev: string, ...args: unknown[]): void;
}

vi.mock("@deepgram/sdk", () => {
  const makeFakeSocket = (): FakeSocket => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const fake: FakeSocket = {
      on(ev, fn) {
        // V1Socket replaces — not appends — the listener per event.
        listeners.set(ev, fn);
      },
      connect() {
        return fake;
      },
      async waitForOpen() {
        // Immediately resolves in tests.
      },
      close() {
        /* no-op */
      },
      sendMedia(_data: ArrayBufferView) {
        /* no-op */
      },
      _fire(ev, ...args) {
        const fn = listeners.get(ev);
        if (fn) fn(...args);
      },
    };
    return fake;
  };

  return {
    DeepgramClient: class {
      listen = {
        v1: {
          connect: (_args: unknown): Promise<FakeSocket> => Promise.resolve(makeFakeSocket()),
        },
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(transcript: string, isFinal: boolean) {
  return {
    type: "Results" as const,
    channel_index: [0],
    duration: 1,
    start: 0,
    is_final: isFinal,
    channel: { alternatives: [{ transcript, confidence: 0.9, words: [] }] },
    metadata: { request_id: "mock" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Deepgram STT adapter", () => {
  test("openDeepgram({}) returns an opener with name 'deepgram'", () => {
    const opener = openDeepgram({});
    expect(opener.name).toBe("deepgram");
  });

  test("throws stt_auth_failed when API key is missing", async () => {
    // Clear env var for this test.
    const saved = process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;

    const opener = openDeepgram({});
    const controller = new AbortController();

    await expect(
      opener.open({ sampleRate: 16_000, apiKey: "", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "stt_auth_failed" });

    process.env.DEEPGRAM_API_KEY = saved;
  });

  test("final transcript fires 'final' event with text", async () => {
    const opener = openDeepgram({ model: "nova-3" });
    const controller = new AbortController();
    const session = (await opener.open({
      sampleRate: 16_000,
      apiKey: "test-key",
      signal: controller.signal,
    })) as DeepgramSession;

    const finals: string[] = [];
    session.on("final", (t) => finals.push(t));

    const fake = session._connection as unknown as FakeSocket;
    fake._fire("message", makeResult("hello world", true));

    await flush();
    expect(finals).toEqual(["hello world"]);

    await session.close();
  });

  test("interim transcript fires 'partial' event with text", async () => {
    const opener = openDeepgram({ model: "nova-3" });
    const controller = new AbortController();
    const session = (await opener.open({
      sampleRate: 16_000,
      apiKey: "test-key",
      signal: controller.signal,
    })) as DeepgramSession;

    const partials: string[] = [];
    session.on("partial", (t) => partials.push(t));

    const fake = session._connection as unknown as FakeSocket;
    fake._fire("message", makeResult("hel", false));
    fake._fire("message", makeResult("hello", false));

    await flush();
    expect(partials).toEqual(["hel", "hello"]);

    await session.close();
  });

  test("empty transcript is NOT emitted (neither partial nor final)", async () => {
    const opener = openDeepgram({});
    const controller = new AbortController();
    const session = (await opener.open({
      sampleRate: 16_000,
      apiKey: "test-key",
      signal: controller.signal,
    })) as DeepgramSession;

    const partials: string[] = [];
    const finals: string[] = [];
    session.on("partial", (t) => partials.push(t));
    session.on("final", (t) => finals.push(t));

    const fake = session._connection as unknown as FakeSocket;
    // Fire results with empty transcript — neither should be emitted.
    fake._fire("message", makeResult("", false));
    fake._fire("message", makeResult("", true));

    await flush();
    expect(partials).toEqual([]);
    expect(finals).toEqual([]);

    await session.close();
  });

  test("close fires close() and subsequent events are ignored (no double-close crash)", async () => {
    const opener = openDeepgram({});
    const controller = new AbortController();
    const session = (await opener.open({
      sampleRate: 16_000,
      apiKey: "test-key",
      signal: controller.signal,
    })) as DeepgramSession;

    const finals: string[] = [];
    session.on("final", (t) => finals.push(t));

    await session.close();

    // Subsequent close should not throw.
    await session.close();

    // Events after close should be dropped.
    const fake = session._connection as unknown as FakeSocket;
    fake._fire("message", makeResult("should be ignored", true));

    await flush();
    expect(finals).toEqual([]);
  });

  test("sendAudio(Int16Array) forwards PCM bytes to the connection", async () => {
    const opener = openDeepgram({});
    const controller = new AbortController();
    const session = (await opener.open({
      sampleRate: 16_000,
      apiKey: "test-key",
      signal: controller.signal,
    })) as DeepgramSession;

    const fake = session._connection as unknown as FakeSocket;
    const sent: ArrayBufferView[] = [];
    fake.sendMedia = (data: ArrayBufferView) => sent.push(data);

    const pcm = new Int16Array([100, 200, 300]);
    session.sendAudio(pcm);

    expect(sent).toHaveLength(1);
    // The sent buffer should contain the same bytes as the Int16Array.
    const sentBytes = new Uint8Array(
      (sent[0] as Uint8Array).buffer,
      (sent[0] as Uint8Array).byteOffset,
      (sent[0] as Uint8Array).byteLength,
    );
    const expectedBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    expect(sentBytes).toEqual(expectedBytes);

    await session.close();
  });
});
