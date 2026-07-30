// Copyright 2026 the AAI authors. MIT license.
// Barge-in / interruption specs for the pipeline transport: STT partial and
// final interrupts, pending client playback, minBargeInWords gating, and
// cancelReply(). Other transport specs live in pipeline-transport.test.ts;
// shared helpers in _pipeline-transport-harness.ts.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { inFlightReplyScript, makeOpts } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

describe("PipelineTransport", () => {
  describe("barge-in", () => {
    test("partial STT event while the agent is speaking triggers cancel and onCancelled", async () => {
      const script = inFlightReplyScript();
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      // The turn must have SPOKEN, not merely started: barge-in gates on audio
      // having been emitted, so text reaching TTS is not enough.
      tts.last()?.fireAudio(new Int16Array(2400));

      stt.last()?.firePartial("wait stop"); // ≥2 words → interrupts at the default threshold
      expect(callbacks.onCancelled).toHaveBeenCalled();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      await t.stop();
    });

    test("partial STT before the turn has emitted audio does NOT cancel", async () => {
      // The agent is still preparing its reply — nothing is being said over, so
      // there is nothing to interrupt. Aborting here would discard the whole
      // in-flight turn and restart a strictly slower one, so a user who keeps
      // re-prompting into the silence ("hello? any update?") could starve the
      // reply forever: every restart outlives the next re-prompt.
      const script = inFlightReplyScript();
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      // No fireAudio: the turn is in flight but has not spoken a single chunk.

      stt.last()?.firePartial("hello are you there");
      expect(callbacks.onCancelled).not.toHaveBeenCalled();
      expect(tts.last()?.cancel).not.toHaveBeenCalled();
      await t.stop();
    });

    test("final STT before the turn has emitted audio defers instead of aborting", async () => {
      // The re-prompt is still answered — it commits a transcript and chains a
      // turn behind the running one (the same deferral path a below-threshold
      // utterance already takes) rather than cancelling the reply in progress.
      const script = inFlightReplyScript();
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      stt.last()?.fireFinal("hello any update");
      await vi.waitFor(() => {
        expect(callbacks.onUserTranscript).toHaveBeenCalledWith("hello any update");
      });
      expect(callbacks.onCancelled).not.toHaveBeenCalled();
      expect(tts.last()?.cancel).not.toHaveBeenCalled();
      await t.stop();
    });

    test("a reply that has not spoken yet survives repeated re-prompts and still lands", async () => {
      // The livelock this gate exists to prevent: a caller re-prompting into the
      // silence of a slow reply ("hello? any update?") used to abort and restart
      // the turn on every utterance. Each restart redid the work on a longer
      // history, so it outlived the next re-prompt and the reply never landed.
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({
          script: Array.from({ length: 20 }, (_, i) => ({ type: "text" as const, text: `p${i} ` })),
          delayMs: 10,
        }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("what is my balance");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      // Two re-prompts land while the reply is still being computed.
      stt.last()?.fireFinal("hello any update");
      stt.last()?.fireFinal("are you still there");

      expect(callbacks.onCancelled).not.toHaveBeenCalled();
      // The reply still finishes rather than being starved by the re-prompts.
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });
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
      const script = inFlightReplyScript();
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
      const script = inFlightReplyScript();
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
      tts.last()?.fireAudio(new Int16Array(2400)); // the agent is now speaking

      stt.last()?.firePartial("wait now"); // two words — meets threshold
      expect(callbacks.onCancelled).toHaveBeenCalled();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      await t.stop();
    });

    test("minBargeInWords gate: a one-word final does NOT interrupt while speaking when threshold is 2", async () => {
      const script = inFlightReplyScript();
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
      tts.last()?.fireAudio(new Int16Array(2400)); // the agent is now speaking

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

    test("TTS audio landing after a barge-in abort is dropped until the next turn speaks", async () => {
      // Step 1: a long in-flight reply to barge into; step 2: the next turn.
      const llm = createFakeLanguageModel({
        steps: [inFlightReplyScript(), [{ type: "text", text: "second reply" }]],
        delayMs: 20,
      });
      const { opts, stt, tts, callbacks } = makeOpts({ llm });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      tts.last()?.fireAudio(new Int16Array(2400));
      expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1);

      stt.last()?.firePartial("wait stop");
      expect(callbacks.onCancelled).toHaveBeenCalledTimes(1);

      // A chunk already in flight lands after the abort flushed the client:
      // it must not reach the client or re-advance the playback clock...
      tts.last()?.fireAudio(new Int16Array(240_000));
      expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1);
      // ...because a re-opened floor would make the user's continuing speech
      // fire a second spurious cancel.
      stt.last()?.firePartial("wait stop please");
      expect(callbacks.onCancelled).toHaveBeenCalledTimes(1);

      // The gate reopens with the next turn's first TTS text, so its own
      // first chunks are never dropped.
      stt.last()?.fireFinal("next question please");
      await vi.waitFor(() => {
        expect(llm.calls.length).toBe(2);
        expect(tts.last()?.textChunks.length).toBeGreaterThan(1);
      });
      tts.last()?.fireAudio(new Int16Array(2400));
      expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(2);
      await t.stop();
    });

    test("cancelReply() aborts the turn and calls ttsSession.cancel()", async () => {
      const script = inFlightReplyScript();
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

  describe("turn invalidation (queued turns, deferred persistence)", () => {
    /**
     * Queue a second turn behind an in-flight one: a sub-threshold final
     * ("yeah", below the default 2-word barge-in gate) does not interrupt —
     * it commits and is deferred via chainTurn until the active reply ends.
     */
    async function startWithQueuedTurn() {
      const llm = createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 });
      const { opts, stt, tts, callbacks } = makeOpts({ llm });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("first question please");
      // Plain throws, not expect(): assertions may not live outside test().
      await vi.waitFor(() => {
        if (llm.calls.length !== 1) throw new Error("first turn not started");
      });
      stt.last()?.fireFinal("yeah");
      await vi.waitFor(() => {
        const transcribed = (callbacks.onUserTranscript as ReturnType<typeof vi.fn>).mock.calls;
        if (!transcribed.some(([text]) => text === "yeah")) throw new Error("not committed");
      });
      return { t, llm, stt, tts, callbacks };
    }

    test("a turn queued behind an active one does not run after stop()", async () => {
      const { t, llm } = await startWithQueuedTurn();
      // Without the enqueue-epoch gate the queued turn runs a full billed
      // streamText turn against closed providers AFTER stop() — and stop()
      // hangs on its TTS drain for the whole flush timeout.
      await t.stop();
      await new Promise((r) => setTimeout(r, 50));
      expect(llm.calls.length).toBe(1);
    });

    test("a turn queued behind an active one does not run after reset()", async () => {
      const { t, llm } = await startWithQueuedTurn();
      t.reset?.();
      // The queued turn carries pre-reset user text: it must not run into the
      // fresh history.
      await new Promise((r) => setTimeout(r, 50));
      expect(llm.calls.length).toBe(1);
      await t.stop();
    });

    test("a turn queued behind an active one does not run after cancelReply()", async () => {
      const { t, llm } = await startWithQueuedTurn();
      t.cancelReply();
      await new Promise((r) => setTimeout(r, 50));
      expect(llm.calls.length).toBe(1);
      await t.stop();
    });

    test("reset() discards the aborted turn's interrupted-turn persistence", async () => {
      const llm = createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 });
      const { opts, stt, tts, callbacks } = makeOpts({ llm });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("question");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      t.reset?.();
      await new Promise((r) => setTimeout(r, 50));
      // persistInterruptedTurn runs after the abort settles; post-reset it
      // must neither emit the interrupted transcript (after the reset ack)
      // nor push the `[interrupted]` tail into the just-cleared history.
      expect(callbacks.onAgentTranscript).not.toHaveBeenCalled();
      await t.stop();
    });

    test("cancelReply() still records the interrupted reply", async () => {
      // Contrast with reset(): a client cancel means "stop responding", not
      // "forget the conversation" — the spoken-so-far text stays in history.
      const llm = createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 });
      const { opts, stt, tts, callbacks } = makeOpts({ llm });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("question");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      t.cancelReply();
      await vi.waitFor(() => {
        expect(callbacks.onAgentTranscript).toHaveBeenCalledWith(expect.any(String), true);
      });
      await t.stop();
    });

    test("cancelReply() discards a buffered utterance still settling", async () => {
      const { opts, stt, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
        endpointSettleMs: 60,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("I was saying"); // fragment: buffers for the settle window
      t.cancelReply();
      // Without the settler reset, the utterance commits ~settleMs after the
      // user pressed stop and launches a fresh turn.
      await new Promise((r) => setTimeout(r, 150));
      expect(callbacks.onUserTranscript).not.toHaveBeenCalled();
      expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
      await t.stop();
    });
  });
});
