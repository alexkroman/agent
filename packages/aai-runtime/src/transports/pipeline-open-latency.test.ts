// Copyright 2026 the AAI authors. MIT license.
// Session-open latency behavior: each provider side goes live as soon as it
// connects, so first greeting audio is not gated on the slower connect.
// (Lives outside pipeline-transport.test.ts, which is near its length cap.)

import type { SttOpener, SttOpenOptions, SttSession } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
} from "../_pipeline-test-fakes.ts";
import { silentLogger } from "../_test-utils.ts";
import { makeCallbacks } from "./_transport-recorder.ts";
import { createPipelineTransport, type PipelineTransportOptions } from "./pipeline-transport.ts";

/** STT opener whose open() blocks until release() is called. */
function makeGatedStt(): {
  opener: SttOpener;
  release: () => void;
  inner: ReturnType<typeof createFakeSttProvider>;
} {
  const inner = createFakeSttProvider();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
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
      stt: gated.opener,
      llm: createFakeLanguageModel({ script: [] }),
      tts,
      callbacks,
      sessionConfig: { systemPrompt: "s", greeting: "Hi there!" },
      executeTool: async () => {
        throw new Error("No executeTool provided to test");
      },
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
    expect(callbacks.reported("error.reported")).not.toHaveBeenCalled();
    await t.stop();
  });

  test("greeting audio still stops when STT subsequently fails to open", async () => {
    const { promise: gate, reject } = Promise.withResolvers<never>();
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
      stt,
      llm: createFakeLanguageModel({ script: [] }),
      tts,
      callbacks,
      executeTool: async () => {
        throw new Error("No executeTool provided to test");
      },
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
    expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
      type: "error.reported",
      code: "stt",
      message: "stt connect failed",
      fatal: true,
    });
    expect(tts.last()?.closed.value).toBe(true);
  });
});
