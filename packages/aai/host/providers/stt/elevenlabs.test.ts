// Copyright 2026 the AAI authors. MIT license.
/** Unit test for the ElevenLabs Scribe STT adapter (mocked SDK). */

import { describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
import { openElevenLabs } from "./elevenlabs.ts";

// ---------------------------------------------------------------------------
// Mock the @elevenlabs/elevenlabs-js realtime client so no real sockets open.
//
// The fake connection keeps one listener per RealtimeEvents value (the SDK's
// EventEmitter API allows multiple, but for simple unit tests one is enough)
// and exposes `_fire` for tests to inject events.
// ---------------------------------------------------------------------------

interface FakeConnection {
  on(ev: string, fn: (data: unknown) => void): void;
  send(_: { audioBase64: string }): void;
  close(): void;
  _fire(ev: string, data: unknown): void;
}

const captured: { connections: FakeConnection[] } = { connections: [] };

vi.mock("@elevenlabs/elevenlabs-js", () => {
  return {
    ElevenLabsClient: class {
      speechToText = {
        realtime: {
          connect: async (_opts: unknown): Promise<FakeConnection> => {
            const listeners = new Map<string, (data: unknown) => void>();
            const conn: FakeConnection = {
              on(ev, fn) {
                listeners.set(ev, fn);
              },
              send() {
                /* no-op */
              },
              close() {
                /* no-op */
              },
              _fire(ev, data) {
                const fn = listeners.get(ev);
                if (fn) fn(data);
              },
            };
            captured.connections.push(conn);
            return conn;
          },
        },
      };
    },
  };
});

vi.mock("@elevenlabs/elevenlabs-js/wrapper/realtime", () => ({
  AudioFormat: {
    PCM_8000: "pcm_8000",
    PCM_16000: "pcm_16000",
    PCM_22050: "pcm_22050",
    PCM_24000: "pcm_24000",
    PCM_44100: "pcm_44100",
    PCM_48000: "pcm_48000",
  },
  CommitStrategy: { VAD: "vad", MANUAL: "manual" },
  RealtimeEvents: {
    SESSION_STARTED: "session_started",
    PARTIAL_TRANSCRIPT: "partial_transcript",
    COMMITTED_TRANSCRIPT: "committed_transcript",
    ERROR: "error",
    AUTH_ERROR: "auth_error",
  },
}));

// Helper: open a session backed by a captured fake connection.
async function openSession(sampleRate = 16_000) {
  captured.connections.length = 0;
  const opener = openElevenLabs({});
  const controller = new AbortController();
  const session = await opener.open({
    sampleRate,
    apiKey: "test-key",
    signal: controller.signal,
  });
  const fake = captured.connections.at(-1);
  if (!fake) throw new Error("no fake connection captured");
  return { session, fake, controller };
}

describe("ElevenLabs Scribe STT adapter", () => {
  test("openElevenLabs() returns an opener with name 'elevenlabs'", () => {
    expect(openElevenLabs({}).name).toBe("elevenlabs");
  });

  test("throws stt_auth_failed when API key is missing", async () => {
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;

    const opener = openElevenLabs({});
    const controller = new AbortController();
    await expect(
      opener.open({ sampleRate: 16_000, apiKey: "", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "stt_auth_failed" });

    if (saved !== undefined) process.env.ELEVENLABS_API_KEY = saved;
  });

  test("partial_transcript fires 'partial' with msg.text", async () => {
    const { session, fake } = await openSession();
    const partials: string[] = [];
    session.on("partial", (t) => partials.push(t));

    fake._fire("partial_transcript", { message_type: "partial_transcript", text: "hel" });
    fake._fire("partial_transcript", { message_type: "partial_transcript", text: "hello" });

    await flush();
    expect(partials).toEqual(["hel", "hello"]);
    await session.close();
  });

  test("committed_transcript fires 'final' with msg.text", async () => {
    const { session, fake } = await openSession();
    const finals: string[] = [];
    session.on("final", (t) => finals.push(t));

    fake._fire("committed_transcript", {
      message_type: "committed_transcript",
      text: "hello world",
    });

    await flush();
    expect(finals).toEqual(["hello world"]);
    await session.close();
  });

  test("empty transcripts are NOT emitted", async () => {
    const { session, fake } = await openSession();
    const partials: string[] = [];
    const finals: string[] = [];
    session.on("partial", (t) => partials.push(t));
    session.on("final", (t) => finals.push(t));

    fake._fire("partial_transcript", { message_type: "partial_transcript", text: "" });
    fake._fire("committed_transcript", { message_type: "committed_transcript", text: "" });

    await flush();
    expect(partials).toEqual([]);
    expect(finals).toEqual([]);
    await session.close();
  });

  test("error event surfaces an stt_stream_error with the server message", async () => {
    const { session, fake } = await openSession();
    const errors: string[] = [];
    session.on("error", (e) => errors.push(e.message));

    fake._fire("error", { message_type: "transcriber_error", error: "boom" });

    await flush();
    expect(errors).toEqual(["boom"]);
    await session.close();
  });

  test("auth_error event maps to stt_auth_failed", async () => {
    const { session, fake } = await openSession();
    const codes: string[] = [];
    session.on("error", (e) => codes.push(e.code));

    fake._fire("auth_error", { message_type: "auth_error", error: "bad key" });

    await flush();
    expect(codes).toEqual(["stt_auth_failed"]);
    await session.close();
  });

  test("close() is idempotent and silences subsequent events", async () => {
    const { session, fake } = await openSession();
    const finals: string[] = [];
    session.on("final", (t) => finals.push(t));

    await session.close();
    await session.close();

    fake._fire("committed_transcript", {
      message_type: "committed_transcript",
      text: "ignored",
    });

    await flush();
    expect(finals).toEqual([]);
  });

  test("rejects unsupported sample rate at open time", async () => {
    const opener = openElevenLabs({});
    const controller = new AbortController();
    await expect(
      opener.open({ sampleRate: 12_345, apiKey: "test-key", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "stt_connect_failed" });
  });
});
