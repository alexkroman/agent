// Copyright 2026 the AAI authors. MIT license.
// The pipeline lifecycle (`createPipelineLifecycle`), through the transport it
// is assembled into: start() opens both providers, stop() tears down even a
// session still connecting, and a provider failure — at open or mid-session —
// reports the session over and detaches every listener. The greeting, the
// lifecycle's other half, is greeting.test.ts's.

import { describe, expect, test, vi } from "vitest";
import {
  createFailingSttProvider,
  createFailingTtsProvider,
  createFakeTtsProvider,
} from "../../_pipeline-test-fakes.ts";
import type { SttOpener, SttSession } from "../../providers/openers.ts";
import { makeOpts, useVirtualTime } from "../_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./transport.ts";

useVirtualTime();

describe("pipeline lifecycle", () => {
  describe("start()", () => {
    test("opens both STT and TTS sessions", async () => {
      const { opts, stt, tts } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      expect(stt.last()).toBeDefined();
      expect(tts.last()).toBeDefined();
      await t.stop();
    });

    test("passes correct keys and sample rate to STT opener", async () => {
      const { opts, stt } = makeOpts({
        providerKeys: { stt: "MY_STT_KEY", tts: "t" },
        sttSampleRate: 8000,
        sttPrompt: "be brief",
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(stt.last()?.options.sampleRate).toBe(8000);
      expect(stt.last()?.options.apiKey).toBe("MY_STT_KEY");
      expect(stt.last()?.options.sttPrompt).toBe("be brief");
      await t.stop();
    });
  });

  describe("stop()", () => {
    test("closes both STT and TTS sessions", async () => {
      const { opts, stt, tts } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      await t.stop();
      expect(stt.last()?.closed.value).toBe(true);
      expect(tts.last()?.closed.value).toBe(true);
    });

    test("stop() is idempotent", async () => {
      const { opts, stt } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      await t.stop();
      await t.stop();
      expect(stt.last()?.closed.value).toBe(true);
    });

    test("stop() waits for an in-flight start() and tears down the mid-connect session", async () => {
      // STT open hangs, simulating a client that disconnects while providers
      // are still connecting. stop() must not resolve until the open settles,
      // and the session that lands after the abort must be closed (not leaked).
      const closeStt = vi.fn(async () => undefined);
      const open = Promise.withResolvers<SttSession>();
      const slowStt: SttOpener = { name: "slow-stt", open: () => open.promise };
      const { opts } = makeOpts({ stt: slowStt });
      const t = createPipelineTransport(opts);

      void t.start();
      let stopResolved = false;
      const stopP = t.stop().then(() => {
        stopResolved = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(stopResolved).toBe(false); // blocked on the in-flight open

      const landed: SttSession = {
        sendAudio: vi.fn(),
        on: (() => () => undefined) as SttSession["on"],
        close: closeStt,
      };
      open.resolve(landed);
      await stopP;

      expect(stopResolved).toBe(true);
      expect(closeStt).toHaveBeenCalled();
    });
  });

  describe("provider errors", () => {
    test("STT error fires onError('stt', ...) and terminates transport", async () => {
      const { opts, stt, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireError("stt_stream_error", "stt failed");
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "stt failed",
        fatal: true,
      });
      await t.stop();
    });

    test("TTS error fires onError('tts', ...) and terminates transport", async () => {
      const { opts, tts, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      tts.last()?.fireError("tts_stream_error", "tts failed");
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "tts",
        message: "tts failed",
        fatal: true,
      });
      await t.stop();
    });

    test("a terminate detaches the provider listeners, the way stop() does", async () => {
      // Teardown's job is that nothing further happens. A terminate that left
      // every STT/TTS listener attached rested instead on four separate
      // downstream guards each staying true — the audio gate, the two
      // `isTerminated` checks, the aborted session signal — so the unsubscribe
      // belongs in the part both teardown paths share.
      const { opts, stt, tts } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      const sttEmitter = stt.last()?.emitter;
      const ttsEmitter = tts.last()?.emitter;
      expect(sttEmitter?.events.partial?.length).toBeGreaterThan(0);
      expect(ttsEmitter?.events.audio?.length).toBeGreaterThan(0);

      stt.last()?.fireError("stt_stream_error", "stt failed");

      expect(sttEmitter?.events.partial ?? []).toHaveLength(0);
      expect(ttsEmitter?.events.audio ?? []).toHaveLength(0);
      await t.stop();
    });

    test("STT open failure fires onError('stt', ...) via reportOpenRejection", async () => {
      const { opts, callbacks } = makeOpts({
        stt: createFailingSttProvider("stt_connect_failed", "connect failed"),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "connect failed",
        fatal: true,
      });
      await t.stop();
    });

    test("TTS open failure fires onError('tts', ...) via reportOpenRejection", async () => {
      const { opts, callbacks } = makeOpts({
        tts: createFailingTtsProvider("tts_connect_failed", "tts connect failed"),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "tts",
        message: "tts connect failed",
        fatal: true,
      });
      await t.stop();
    });

    test("a session that cannot start says so instead of holding a silent line", async () => {
      // STT and TTS open independently, so the usual failure leaves a working
      // voice and nothing to listen with. Silence is indistinguishable from a
      // dead call from the caller's side.
      const tts = createFakeTtsProvider();
      const { opts, callbacks } = makeOpts(
        {
          stt: createFailingSttProvider("stt_connect_failed", "connect timed out"),
          tts,
          startFailurePhrase: "Sorry, I cannot hear you. Please call back.",
        },
        { tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();

      expect(tts.last()?.textChunks.join("")).toContain("cannot hear you");
      // Spoken, and surfaced as a transcript so captions match the audio.
      expect(callbacks.reported("agentTranscript.committed")).toHaveBeenCalledWith({
        type: "agentTranscript.committed",
        text: expect.stringContaining("cannot hear you"),
        // ...and tagged as a recovery phrase, which is what keeps it out of the
        // conversation every reader reconstructs from the stream.
        recovery: "session-failed",
      });
      // Still a failed start: the client must learn the session is dead.
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "connect timed out",
        fatal: true,
      });
      await t.stop();
    });

    test("stays silent when TTS is the side that failed", async () => {
      // Nothing to speak with; the phrase must not wedge the teardown waiting
      // on a provider that never opened.
      const { opts, callbacks } = makeOpts({
        tts: createFailingTtsProvider("tts_connect_failed", "tts connect failed"),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("agentTranscript.committed")).not.toHaveBeenCalled();
      await t.stop();
    });

    test('startFailurePhrase "" disables the spoken failure', async () => {
      const tts = createFakeTtsProvider();
      const { opts, callbacks } = makeOpts(
        {
          stt: createFailingSttProvider("stt_connect_failed", "connect timed out"),
          tts,
          startFailurePhrase: "",
        },
        { tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("agentTranscript.committed")).not.toHaveBeenCalled();
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "connect timed out",
        fatal: true,
      });
      await t.stop();
    });

    test("when STT fails, TTS session is still opened but then immediately closed", async () => {
      const tts = createFakeTtsProvider();
      const { opts } = makeOpts(
        {
          stt: createFailingSttProvider("stt_connect_failed", "bad key"),
          tts,
        },
        { tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      // Promise.allSettled opens both concurrently; STT failure then closes TTS.
      expect(tts.last()?.closed.value).toBe(true);
      await t.stop();
    });
  });
});
