// Copyright 2026 the AAI authors. MIT license.
/**
 * The STT/TTS provider fakes every pipeline spec drives, and the registration
 * that lets a runtime resolve them exactly as it resolves a real provider.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createFailingSttProvider,
  createFailingTtsProvider,
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  createTestClock,
  FAKE_STT_API_KEY_ENV,
  recordingTts,
  registerFakeProviders,
  speakFor,
} from "./_pipeline-test-fakes.ts";
import { resolveLlm, resolveStt, resolveTts } from "./providers/resolve.ts";

const OPEN = { sampleRate: 16_000, apiKey: "k", signal: new AbortController().signal };

describe("createFakeSttProvider", () => {
  test("records each opened session, its audio and its close", async () => {
    const stt = createFakeSttProvider();
    expect(stt.last()).toBeUndefined();
    const session = await stt.open(OPEN);
    const fake = stt.last();
    expect(fake).toBe(session);
    session.sendAudio(new Int16Array([1, 2, 3]));
    await session.close();
    expect(fake?.audioFrames).toEqual([new Int16Array([1, 2, 3])]);
    expect(fake?.closed.value).toBe(true);
    expect(fake?.options).toBe(OPEN);
  });

  test("fires partials, finals and coded errors to subscribers", async () => {
    const stt = createFakeSttProvider();
    const session = await stt.open(OPEN);
    const partial = vi.fn();
    const final = vi.fn();
    const error = vi.fn();
    session.on("partial", partial);
    session.on("final", final);
    session.on("error", error);
    stt.last()?.firePartial("hel");
    stt.last()?.fireFinal("hello", { endOfTurnConfidence: 0.9 });
    stt.last()?.fireError("stt_stream_error", "boom");
    expect(partial).toHaveBeenCalledWith("hel", undefined);
    expect(final).toHaveBeenCalledWith("hello", { endOfTurnConfidence: 0.9 });
    expect(error.mock.calls[0]?.[0]).toMatchObject({ code: "stt_stream_error", message: "boom" });
  });
});

describe("createFakeTtsProvider", () => {
  test("records text, and answers `done` on flush and on cancel", async () => {
    const tts = createFakeTtsProvider();
    const session = await tts.open(OPEN);
    const done = vi.fn();
    session.on("done", done);
    session.sendText("Hi");
    session.flush();
    session.cancel();
    expect(tts.last()?.textChunks).toEqual(["Hi"]);
    expect(done).toHaveBeenCalledTimes(2);
  });

  test("`autoDoneOnFlush: false` leaves `done` to the spec", async () => {
    const tts = createFakeTtsProvider({ autoDoneOnFlush: false });
    const session = await tts.open(OPEN);
    const done = vi.fn();
    session.on("done", done);
    session.flush();
    expect(done).not.toHaveBeenCalled();
  });

  test("`speakFor` emits that many ms of audio and advances the clock", async () => {
    const tts = createFakeTtsProvider();
    const session = await tts.open(OPEN);
    const audio = vi.fn();
    session.on("audio", audio);
    const clock = createTestClock(0);
    speakFor(tts, clock, 500, 200);
    expect(audio.mock.calls[0]?.[0]).toHaveLength(12_000);
    expect(clock.now()).toBe(200);
  });
});

describe("the small fakes", () => {
  test("`recordingTts` collects what was sent", () => {
    const spoken: string[] = [];
    const tts = recordingTts(spoken);
    tts.sendText("a");
    tts.sendText("b");
    expect(spoken).toEqual(["a", "b"]);
  });

  test("the failing providers reject `open` with a coded error", async () => {
    await expect(
      createFailingSttProvider("stt_auth_failed", "no").open(OPEN),
    ).rejects.toMatchObject({ code: "stt_auth_failed", message: "no" });
    await expect(
      createFailingTtsProvider("tts_connect_failed", "down").open(OPEN),
    ).rejects.toMatchObject({ code: "tts_connect_failed" });
  });
});

describe("registerFakeProviders", () => {
  test("registers only the supplied fakes, resolvable with the returned env", () => {
    const stt = createFakeSttProvider();
    const llm = createFakeLanguageModel({ script: [] });
    const registered = registerFakeProviders({ stt, llm });
    try {
      expect(registered.tts).toBeUndefined();
      expect(registered.env[FAKE_STT_API_KEY_ENV]).toBeTypeOf("string");
      if (registered.stt === undefined || registered.llm === undefined) {
        expect.fail("expected an STT and an LLM descriptor");
      }
      expect(resolveStt(registered.stt, registered.env).opener).toBe(stt);
      expect(resolveLlm(registered.llm, registered.env)).toBe(llm);
    } finally {
      registered.unregister();
    }
  });

  test("unregister removes the kinds again", () => {
    const registered = registerFakeProviders({ tts: createFakeTtsProvider() });
    const descriptor = registered.tts;
    registered.unregister();
    if (descriptor === undefined) expect.fail("expected a TTS descriptor");
    expect(() => resolveTts(descriptor, registered.env)).toThrow(/fake-tts/);
  });
});
