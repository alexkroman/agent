// Copyright 2026 the AAI authors. MIT license.
// `createPipelineProviderSessions`: concurrent open, adoption, event routing,
// and teardown of the STT/TTS pair.

import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "../../_logger-test-utils.ts";
import {
  createFailingTtsProvider,
  createFakeSttProvider,
  createFakeTtsProvider,
} from "../../_pipeline-test-fakes.ts";
import type { TtsOpener } from "../../providers/openers.ts";
import { createPipelineProviderSessions, type PipelineProviderOptions } from "./providers.ts";

function setup(overrides: Partial<PipelineProviderOptions> = {}) {
  const stt = createFakeSttProvider();
  const tts = createFakeTtsProvider();
  const handlers = {
    onSttPartial: vi.fn(),
    onSttFinal: vi.fn(),
    onSttError: vi.fn(),
    onTtsError: vi.fn(),
    onTtsAudio: vi.fn(),
    onTtsWords: vi.fn(),
  };
  const opts: PipelineProviderOptions = {
    sid: "sid",
    stt,
    tts,
    providerKeys: { stt: "stt-key", tts: "tts-key" },
    sttSampleRate: 16_000,
    ttsSampleRate: 24_000,
    sttPrompt: "names: Ada",
    signal: new AbortController().signal,
    handlers,
    onAudioReady: vi.fn(),
    emitError: vi.fn(),
    log: makeLogger(),
    ...overrides,
  };
  return { stt, tts, handlers, opts, sessions: createPipelineProviderSessions(opts) };
}

describe("createPipelineProviderSessions", () => {
  test("open adopts both sides, passing each its own key and rate", async () => {
    const { stt, tts, opts, sessions } = setup();
    expect(sessions.stt).toBeNull();
    await expect(sessions.open()).resolves.toBe("ok");
    expect(sessions.stt).toBe(stt.last());
    expect(sessions.tts).toBe(tts.last());
    expect(stt.last()?.options).toMatchObject({
      sampleRate: 16_000,
      apiKey: "stt-key",
      sttPrompt: "names: Ada",
    });
    expect(tts.last()?.options).toMatchObject({ sampleRate: 24_000, apiKey: "tts-key" });
    expect(opts.onAudioReady).toHaveBeenCalledTimes(1);
  });

  test("provider events route to the handlers until unsubscribe", async () => {
    const { stt, tts, handlers, sessions } = setup();
    await sessions.open();
    stt.last()?.firePartial("hel");
    stt.last()?.fireFinal("hello");
    tts.last()?.fireAudio(new Int16Array(4));
    tts.last()?.fireWords([]);
    expect(handlers.onSttPartial).toHaveBeenCalledWith("hel", undefined);
    expect(handlers.onSttFinal).toHaveBeenCalledWith("hello", undefined);
    expect(handlers.onTtsAudio).toHaveBeenCalledTimes(1);
    expect(handlers.onTtsWords).toHaveBeenCalledTimes(1);

    sessions.unsubscribe();
    stt.last()?.fireFinal("again");
    expect(handlers.onSttFinal).toHaveBeenCalledTimes(1);
  });

  test("a side that fails to open is reported and the open resolves failed", async () => {
    const { stt, opts, sessions } = setup({
      tts: createFailingTtsProvider("tts_connect_failed", "no route"),
    });
    await expect(sessions.open()).resolves.toBe("failed");
    expect(opts.emitError).toHaveBeenCalledWith("tts", expect.stringContaining("no route"));
    expect(opts.onAudioReady).not.toHaveBeenCalled();
    // The other side still landed; the caller decides how to tear it down.
    expect(sessions.stt).toBe(stt.last());
  });

  test("a session aborted mid-open closes the late arrival instead of adopting it", async () => {
    const ctl = new AbortController();
    const { tts, opts, sessions } = setup({ signal: ctl.signal });
    const gate = Promise.withResolvers<void>();
    const slow: TtsOpener = {
      name: "slow",
      open: async (o) => {
        await gate.promise;
        return tts.open(o);
      },
    };
    const late = createPipelineProviderSessions({ ...opts, tts: slow });
    const opened = late.open();
    ctl.abort();
    gate.resolve();
    await expect(opened).resolves.toBe("ok");
    expect(late.tts).toBeNull();
    expect(tts.last()?.closed.value).toBe(true);
    expect(sessions.tts).toBeNull();
  });

  test("close closes both sides and swallows a rejection", async () => {
    const { stt, tts, sessions } = setup();
    await sessions.open();
    vi.mocked(stt.last()?.close ?? vi.fn()).mockRejectedValueOnce(new Error("already closed"));
    await expect(sessions.close()).resolves.toBeUndefined();
    expect(tts.last()?.closed.value).toBe(true);
  });
});
