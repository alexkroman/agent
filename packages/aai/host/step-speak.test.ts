// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the published speech synthesizer.
 *
 * The subject is the EXCHANGE — which frames go out, which come back, and what
 * every way of not finishing resolves to. `sdk/step-speak.test.ts` owns the
 * surface above it (the WAV framing, the credential, the deadline).
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { flush } from "./_test-utils.ts";
import { FakeWebSocket, pcmBase64 } from "./providers/tts/_fake-ws-test-utils.ts";
import { speakOverWebSocket } from "./step-speak.ts";

// Async factory importing an import-free module: the module under test imports
// "ws" itself, so the factory must not reach it.
vi.mock("ws", async () => {
  const { FakeWebSocket } = await import("./providers/tts/_fake-ws-test-utils.ts");
  return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

beforeEach(() => {
  FakeWebSocket.reset();
});

/** Start one synthesis and hand back its promise plus the socket it opened. */
async function speak(
  overrides: Partial<Parameters<typeof speakOverWebSocket>[0]> = {},
): Promise<{ audio: Promise<Uint8Array>; ws: FakeWebSocket }> {
  const audio = speakOverWebSocket({
    text: "Three findings.",
    apiKey: "aai-key",
    voice: "jane",
    sampleRate: 24_000,
    signal: new AbortController().signal,
    ...overrides,
  });
  // The socket exists synchronously; "open" lands a microtask later.
  await flush();
  const ws = FakeWebSocket.instances[0];
  if (!ws) throw new Error("no socket was opened");
  return { audio, ws };
}

describe("speakOverWebSocket", () => {
  test("dials the streaming-TTS host with the voice and rate as query params", async () => {
    const { audio, ws } = await speak({ voice: "michael", sampleRate: 16_000 });
    ws._msg({ type: "FlushDone" });
    await audio;

    const url = new URL(ws.url);
    expect(url.host).toBe("streaming-tts.assemblyai.com");
    expect(url.pathname).toBe("/v1/ws/");
    expect(url.searchParams.get("voice")).toBe("michael");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
  });

  test("presents the RAW key, not a Bearer token", async () => {
    const { audio, ws } = await speak();
    ws._msg({ type: "FlushDone" });
    await audio;

    expect(ws.options?.headers).toEqual({ Authorization: "aai-key" });
  });

  test("sends Generate AND Flush — a Generate alone synthesizes nothing", async () => {
    const { audio, ws } = await speak({ text: "Three findings." });
    ws._msg({ type: "FlushDone" });
    await audio;

    expect(ws._frames()).toEqual([
      { type: "Generate", text: "Three findings." },
      { type: "Flush" },
      { type: "Terminate" },
    ]);
  });

  test("joins every Audio frame's PCM in arrival order", async () => {
    const { audio, ws } = await speak();
    ws._msg({ type: "Audio", audio: pcmBase64([1, 2]) });
    ws._msg({ type: "Audio", audio: pcmBase64([3]) });
    ws._msg({ type: "FlushDone" });

    const pcm = await audio;
    expect(pcm.length).toBe(6);
    expect(Buffer.from(pcm).readInt16LE(4)).toBe(3);
  });

  test("an `is_final` Audio frame ends the synthesis, for a server that sends no FlushDone", async () => {
    const { audio, ws } = await speak();
    ws._msg({ type: "Audio", audio: pcmBase64([7]), is_final: true });

    expect((await audio).length).toBe(2);
  });

  test("ignores the frames that are not audio and not an ending", async () => {
    const { audio, ws } = await speak();
    ws._msg({ type: "Begin", configuration: { voice: "jane" } });
    ws._msg({ type: "Warning", warning: "something informational" });
    ws._msg({ type: "Audio", audio: pcmBase64([5]) });
    ws._msg({ type: "FlushDone" });

    expect((await audio).length).toBe(2);
  });

  test("an Error frame rejects with the service's own code and reason", async () => {
    const { audio, ws } = await speak();
    ws._msg({ type: "Error", error_code: 1008, error: "Unauthorized: Invalid API key" });

    await expect(audio).rejects.toThrow("AssemblyAI TTS (1008): Unauthorized: Invalid API key");
  });

  test("a close mid-synthesis fails rather than returning the truncated audio", async () => {
    const { audio, ws } = await speak();
    ws._msg({ type: "Audio", audio: pcmBase64([1, 2, 3]) });
    ws._fire("close", 1006);

    await expect(audio).rejects.toThrow("socket closed 1006 before the audio ended");
  });

  test("a socket error rejects with the underlying message", async () => {
    const { audio, ws } = await speak();
    ws._fire("error", new Error("ECONNRESET"));

    await expect(audio).rejects.toThrow("AssemblyAI TTS: ECONNRESET");
  });

  test("only the FIRST outcome settles it — an Error followed by a close stays the Error", async () => {
    const { audio, ws } = await speak();
    ws._msg({ type: "Error", error_code: 4001, error: "nope" });
    ws._fire("close", 1011);

    await expect(audio).rejects.toThrow("(4001): nope");
  });

  test("an abort mid-synthesis rejects and releases the socket", async () => {
    const controller = new AbortController();
    const { audio, ws } = await speak({ signal: controller.signal });
    controller.abort(new Error("the run was cancelled"));

    await expect(audio).rejects.toThrow("synthesis aborted");
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("an already-aborted signal never dials anything", async () => {
    await expect(
      speakOverWebSocket({
        text: "hello",
        apiKey: "k",
        voice: "jane",
        sampleRate: 24_000,
        signal: AbortSignal.abort(new Error("too late")),
      }),
    ).rejects.toThrow("synthesis aborted");
  });

  test("translates the language code, because the wire wants the whole word", async () => {
    const { audio, ws } = await speak({ voice: "lola", language: "es" });
    ws._msg({ type: "FlushDone" });
    await audio;

    expect(new URL(ws.url).searchParams.get("language")).toBe("spanish");
  });

  test("refuses an unsupported language code before opening a socket", async () => {
    await expect(
      speakOverWebSocket({
        text: "hello",
        apiKey: "k",
        voice: "jane",
        language: "kl",
        sampleRate: 24_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('stepSpeak: unsupported language "kl"');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
