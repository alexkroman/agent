// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
import { type DeepgramSession, openDeepgram } from "./deepgram.ts";

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
    // V1Socket replaces — not appends — the listener per event.
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const fake: FakeSocket = {
      on(ev, fn) {
        listeners.set(ev, fn);
      },
      connect() {
        return fake;
      },
      async waitForOpen() {
        /* no-op */
      },
      close() {
        /* no-op */
      },
      sendMedia(_data: ArrayBufferView) {
        /* no-op */
      },
      _fire(ev, ...args) {
        listeners.get(ev)?.(...args);
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

async function openSession(
  args: Parameters<typeof openDeepgram>[0] = {},
): Promise<{ session: DeepgramSession; fake: FakeSocket }> {
  const opener = openDeepgram(args);
  const session = (await opener.open({
    sampleRate: 16_000,
    apiKey: "test-key",
    signal: new AbortController().signal,
  })) as DeepgramSession;
  return { session, fake: session._connection as unknown as FakeSocket };
}

describe("Deepgram STT adapter", () => {
  test("openDeepgram({}) returns an opener with name 'deepgram'", () => {
    expect(openDeepgram({}).name).toBe("deepgram");
  });

  test("throws stt_auth_failed when API key is missing", async () => {
    const saved = process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;

    const opener = openDeepgram({});
    await expect(
      opener.open({ sampleRate: 16_000, apiKey: "", signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "stt_auth_failed" });

    process.env.DEEPGRAM_API_KEY = saved;
  });

  test("final transcript fires 'final' event with text", async () => {
    const { session, fake } = await openSession({ model: "nova-3" });
    const finals: string[] = [];
    session.on("final", (t) => finals.push(t));

    fake._fire("message", makeResult("hello world", true));

    await flush();
    expect(finals).toEqual(["hello world"]);

    await session.close();
  });

  test("interim transcript fires 'partial' event with text", async () => {
    const { session, fake } = await openSession({ model: "nova-3" });
    const partials: string[] = [];
    session.on("partial", (t) => partials.push(t));

    fake._fire("message", makeResult("hel", false));
    fake._fire("message", makeResult("hello", false));

    await flush();
    expect(partials).toEqual(["hel", "hello"]);

    await session.close();
  });

  test("empty transcript is NOT emitted (neither partial nor final)", async () => {
    const { session, fake } = await openSession();
    const partials: string[] = [];
    const finals: string[] = [];
    session.on("partial", (t) => partials.push(t));
    session.on("final", (t) => finals.push(t));

    fake._fire("message", makeResult("", false));
    fake._fire("message", makeResult("", true));

    await flush();
    expect(partials).toEqual([]);
    expect(finals).toEqual([]);

    await session.close();
  });

  test("close fires close() and subsequent events are ignored (no double-close crash)", async () => {
    const { session, fake } = await openSession();
    const finals: string[] = [];
    session.on("final", (t) => finals.push(t));

    await session.close();
    await session.close();

    fake._fire("message", makeResult("should be ignored", true));

    await flush();
    expect(finals).toEqual([]);
  });

  test("sendAudio(Int16Array) forwards PCM bytes to the connection", async () => {
    const { session, fake } = await openSession();
    const sent: ArrayBufferView[] = [];
    fake.sendMedia = (data: ArrayBufferView) => sent.push(data);

    const pcm = new Int16Array([100, 200, 300]);
    session.sendAudio(pcm);

    expect(sent).toHaveLength(1);
    const sentView = sent[0] as Uint8Array;
    const sentBytes = new Uint8Array(sentView.buffer, sentView.byteOffset, sentView.byteLength);
    const expectedBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    expect(sentBytes).toEqual(expectedBytes);

    await session.close();
  });
});
