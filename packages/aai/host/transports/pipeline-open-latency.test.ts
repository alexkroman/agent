// Copyright 2026 the AAI authors. MIT license.
// Session-open latency behavior: each provider side goes live as soon as it
// connects, so first greeting audio is not gated on the slower connect.
// (Lives outside pipeline-transport.test.ts, which is near its length cap.)

import { describe, expect, test, vi } from "vitest";
import type { SttOpener, SttOpenOptions, SttSession } from "../../sdk/providers.ts";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
} from "../_pipeline-test-fakes.ts";
import { silentLogger } from "../_test-utils.ts";
import { createPipelineTransport, type PipelineTransportOptions } from "./pipeline-transport.ts";
import type { TransportCallbacks } from "./types.ts";

function makeCallbacks(): TransportCallbacks {
  return {
    onReplyStarted: vi.fn(),
    onReplyDone: vi.fn(),
    onCancelled: vi.fn(),
    onAudioChunk: vi.fn(),
    onAudioDone: vi.fn(),
    onUserTranscript: vi.fn(),
    onAgentTranscript: vi.fn(),
    onToolCall: vi.fn(),
    onError: vi.fn(),
    onSpeechStarted: vi.fn(),
    onSpeechStopped: vi.fn(),
    onSessionReady: vi.fn(),
  };
}

/** STT opener whose open() blocks until release() is called. */
function makeGatedStt(): {
  opener: SttOpener;
  release: () => void;
  inner: ReturnType<typeof createFakeSttProvider>;
} {
  const inner = createFakeSttProvider();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opener: SttOpener = {
    name: "gated-stt",
    async open(o: SttOpenOptions): Promise<SttSession> {
      await gate;
      return inner.open(o);
    },
  };
  return { opener, release, inner };
}

describe("PipelineTransport — provider-open latency", () => {
  test("greeting starts as soon as TTS connects, without waiting for STT", async () => {
    const gated = makeGatedStt();
    const tts = createFakeTtsProvider();
    const callbacks = makeCallbacks();
    const opts: PipelineTransportOptions = {
      sid: "sid-latency",
      agent: "a",
      stt: gated.opener,
      llm: createFakeLanguageModel({ script: [] }),
      tts,
      callbacks,
      sessionConfig: { systemPrompt: "s", greeting: "Hi there!" },
      providerKeys: { stt: "k", tts: "k" },
      logger: silentLogger,
    };
    const t = createPipelineTransport(opts);

    const startP = t.start(); // STT is still connecting…

    // …but the greeting must already reach TTS.
    await vi.waitFor(() => {
      expect(tts.last()?.sendText).toHaveBeenCalledWith("Hi there!");
    });
    expect(callbacks.onReplyStarted).toHaveBeenCalledWith(expect.stringContaining("greeting"));
    // start() itself is still pending on the STT connect.
    expect(gated.inner.last()).toBeUndefined();

    gated.release();
    await startP;
    expect(gated.inner.last()).toBeDefined();
    expect(callbacks.onError).not.toHaveBeenCalled();
    await t.stop();
  });

  test("greeting audio still stops when STT subsequently fails to open", async () => {
    let reject!: (e: Error) => void;
    const gate = new Promise<never>((_resolve, rej) => {
      reject = rej;
    });
    const stt: SttOpener = {
      name: "failing-gated-stt",
      async open(): Promise<SttSession> {
        return gate;
      },
    };
    const tts = createFakeTtsProvider();
    const callbacks = makeCallbacks();
    const t = createPipelineTransport({
      sid: "sid-latency-2",
      agent: "a",
      stt,
      llm: createFakeLanguageModel({ script: [] }),
      tts,
      callbacks,
      sessionConfig: { systemPrompt: "s", greeting: "Hi there!" },
      providerKeys: { stt: "k", tts: "k" },
      logger: silentLogger,
    });

    const startP = t.start();
    await vi.waitFor(() => {
      expect(tts.last()?.sendText).toHaveBeenCalledWith("Hi there!");
    });

    reject(new Error("stt connect failed"));
    await startP;

    // The failure surfaced, the greeting turn was cancelled, and the adopted
    // TTS session did not outlive the terminate.
    expect(callbacks.onError).toHaveBeenCalledWith("stt", "stt connect failed");
    expect(tts.last()?.closed.value).toBe(true);
  });
});
