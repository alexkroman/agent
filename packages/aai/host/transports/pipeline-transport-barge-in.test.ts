// Copyright 2026 the AAI authors. MIT license.
// Barge-in / interruption specs for the pipeline transport: STT partial and
// final interrupts, pending client playback, minBargeInWords gating, and
// cancelReply(). Other transport specs live in pipeline-transport.test.ts;
// shared helpers in _pipeline-transport-harness.ts.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, type ScriptedPart } from "../_pipeline-test-fakes.ts";
import { makeOpts } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

describe("PipelineTransport", () => {
  describe("barge-in", () => {
    test("partial STT event during an in-flight turn triggers cancel and onCancelled", async () => {
      const script: ScriptedPart[] = [
        { type: "text", text: "Hello " },
        { type: "text", text: "how can " },
        { type: "text", text: "I help?" },
      ];
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      stt.last()?.firePartial("wait stop"); // ≥2 words → interrupts at the default threshold
      expect(callbacks.onCancelled).toHaveBeenCalled();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      await t.stop();
    });

    test("partial STT after the turn finished but with client audio still playing triggers cancel", async () => {
      // Synthesis outruns real-time playback: the server-side turn completes
      // (turnController null) while the client still holds buffered audio.
      // "Stop" arriving in that window must still cancel, or the buffered
      // speech plays out in full.
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "20, 19, 18…" }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("count down from 20");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });

      // 10 s of PCM16 at the default 24 kHz — client playback lags well behind.
      tts.last()?.fireAudio(new Int16Array(240_000));

      stt.last()?.firePartial("stop it"); // ≥2 words → interrupts at the default threshold
      expect(callbacks.onCancelled).toHaveBeenCalled();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      await t.stop();
    });

    test("final STT with client audio still playing cancels stale audio before the new turn", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("count down from 20");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });

      tts.last()?.fireAudio(new Int16Array(240_000));

      stt.last()?.fireFinal("stop that");
      expect(callbacks.onCancelled).toHaveBeenCalled();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      // The new turn still runs after the stale audio is cancelled.
      await vi.waitFor(() => {
        expect(callbacks.onUserTranscript).toHaveBeenCalledWith("stop that");
      });
      await t.stop();
    });

    test("partial STT when idle with no pending playback does not cancel", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });

      // No audio was forwarded, so nothing can be playing client-side.
      stt.last()?.firePartial("hello again");
      expect(callbacks.onCancelled).not.toHaveBeenCalled();
      expect(tts.last()?.cancel).not.toHaveBeenCalled();
      await t.stop();
    });

    test("minBargeInWords gate: a one-word partial does NOT interrupt when threshold is 2", async () => {
      const script: ScriptedPart[] = [
        { type: "text", text: "Hello " },
        { type: "text", text: "how can " },
        { type: "text", text: "I help?" },
      ];
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
        minBargeInWords: 2,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      stt.last()?.firePartial("wait"); // one word — below threshold
      expect(callbacks.onCancelled).not.toHaveBeenCalled();
      expect(tts.last()?.cancel).not.toHaveBeenCalled();
      await t.stop();
    });

    test("minBargeInWords gate: a two-word partial interrupts when threshold is 2", async () => {
      const script: ScriptedPart[] = [
        { type: "text", text: "Hello " },
        { type: "text", text: "how can " },
        { type: "text", text: "I help?" },
      ];
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
        minBargeInWords: 2,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      stt.last()?.firePartial("wait now"); // two words — meets threshold
      expect(callbacks.onCancelled).toHaveBeenCalled();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      await t.stop();
    });

    test("minBargeInWords gate: a one-word final does NOT interrupt while speaking when threshold is 2", async () => {
      const script: ScriptedPart[] = [
        { type: "text", text: "Hello " },
        { type: "text", text: "how can " },
        { type: "text", text: "I help?" },
      ];
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
        minBargeInWords: 2,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      // A one-word FINAL arrives while the agent is speaking — below threshold.
      stt.last()?.fireFinal("yeah");
      await vi.waitFor(() => {
        expect(callbacks.onUserTranscript).toHaveBeenCalledWith("yeah");
      });
      // Below threshold does NOT interrupt the in-flight reply...
      expect(callbacks.onCancelled).not.toHaveBeenCalled();
      expect(tts.last()?.cancel).not.toHaveBeenCalled();
      // ...but it is NOT dropped: it is still transcribed and answered as a
      // deferred turn once the current reply finishes (chainTurn), rather than
      // silently discarded.
      await t.stop();
    });

    test("interruptionMinDurationMs gate: an early partial does NOT interrupt; sustained speech does", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "20, 19, 18…" }] }),
        interruptionMinDurationMs: 100,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("count down from 20");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });
      // 10 s of PCM16 at the default 24 kHz — barge-in stays live on the
      // client playback tail for the whole test.
      tts.last()?.fireAudio(new Int16Array(240_000));

      // First partial opens the speaking edge — 0 ms of sustained speech.
      stt.last()?.firePartial("wait stop");
      expect(callbacks.onCancelled).not.toHaveBeenCalled();

      // The user keeps talking past the duration gate → the next partial interrupts.
      await new Promise((r) => setTimeout(r, 120));
      stt.last()?.firePartial("wait stop that");
      expect(callbacks.onCancelled).toHaveBeenCalled();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      await t.stop();
    });

    test("cancelReply() aborts the turn and calls ttsSession.cancel()", async () => {
      const script: ScriptedPart[] = [
        { type: "text", text: "some " },
        { type: "text", text: "reply" },
      ];
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("question");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      t.cancelReply();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      // cancelReply() doesn't fire onCancelled — session-core calls client.cancelled()
      // itself for client-originated cancels. onCancelled fires only for STT-partial barge-in.
      expect(callbacks.onCancelled).not.toHaveBeenCalled();
      await t.stop();
    });
  });
});
