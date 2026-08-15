// Copyright 2026 the AAI authors. MIT license.
// Barge-in / interruption specs for the pipeline transport: STT partial and
// final interrupts, pending client playback, minBargeInWords gating, and
// cancelReply(). Other transport specs live in pipeline-transport.test.ts;
// shared helpers in _pipeline-transport-harness.ts.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, createTestClock, speakFor } from "../_pipeline-test-fakes.ts";
import {
  inFlightReplyScript,
  llmCalls,
  makeOpts,
  useVirtualTime,
} from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

/** A reply long enough to still be streaming when the re-prompts land. */
const PART_COUNT = 20;
const PART_DELAY_MS = 10;

useVirtualTime();

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
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
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
      expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();
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
        expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
          type: "user-transcript.committed",
          text: "hello any update",
        });
      });
      expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();
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
          script: Array.from({ length: PART_COUNT }, (_, i) => ({
            type: "text" as const,
            text: `p${i} `,
          })),
          delayMs: PART_DELAY_MS,
        }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("what is my balance");
      // One scripted part's worth of virtual time — enough for the reply to be
      // under way, not enough for it to finish.
      await vi.advanceTimersByTimeAsync(PART_DELAY_MS);
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);

      // Two re-prompts land while the reply is still being computed.
      stt.last()?.fireFinal("hello any update");
      stt.last()?.fireFinal("are you still there");

      expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();
      // The reply still finishes rather than being starved by the re-prompts.
      // Driven rather than polled: the script's own length is how long it
      // needs, so there is nothing here for a slow runner to lose a race to.
      await vi.advanceTimersByTimeAsync(PART_COUNT * PART_DELAY_MS);
      expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
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
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });

      // 10 s of PCM16 at the default 24 kHz — client playback lags well behind.
      tts.last()?.fireAudio(new Int16Array(240_000));

      stt.last()?.firePartial("stop it"); // ≥2 words → interrupts at the default threshold
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
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
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });

      tts.last()?.fireAudio(new Int16Array(240_000));

      stt.last()?.fireFinal("stop that");
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
      expect(tts.last()?.cancel).toHaveBeenCalled();
      // The new turn still runs after the stale audio is cancelled.
      await vi.waitFor(() => {
        expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
          type: "user-transcript.committed",
          text: "stop that",
        });
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
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });

      // No audio was forwarded, so nothing can be playing client-side.
      stt.last()?.firePartial("hello again");
      expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();
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
      expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();
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
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
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
        expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
          type: "user-transcript.committed",
          text: "yeah",
        });
      });
      // Below threshold does NOT interrupt the in-flight reply...
      expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();
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
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });
      // 10 s of PCM16 at the default 24 kHz — barge-in stays live on the
      // client playback tail for the whole test.
      tts.last()?.fireAudio(new Int16Array(240_000));

      // First partial opens the speaking edge — 0 ms of sustained speech.
      stt.last()?.firePartial("wait stop");
      expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();

      // The user keeps talking past the duration gate → the next partial interrupts.
      await vi.advanceTimersByTimeAsync(120);
      stt.last()?.firePartial("wait stop that");
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
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
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalledTimes(1);

      // A chunk already in flight lands after the abort flushed the client:
      // it must not reach the client or re-advance the playback clock...
      tts.last()?.fireAudio(new Int16Array(240_000));
      expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1);
      // ...because a re-opened floor would make the user's continuing speech
      // fire a second spurious cancel.
      stt.last()?.firePartial("wait stop please");
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalledTimes(1);

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
      expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();
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
        const committed = callbacks.events.filter(
          (e) => e.type === "user-transcript.committed" && e.text === "yeah",
        );
        if (committed.length === 0) throw new Error("not committed");
      });
      return { t, llm, stt, tts, callbacks };
    }

    test("a turn queued behind an active one does not run after stop()", async () => {
      const { t, llm } = await startWithQueuedTurn();
      // Without the enqueue-epoch gate the queued turn runs a full billed
      // streamText turn against closed providers AFTER stop() — and stop()
      // hangs on its TTS drain for the whole flush timeout.
      await t.stop();
      await vi.advanceTimersByTimeAsync(50);
      expect(llm.calls.length).toBe(1);
    });

    test("a turn queued behind an active one does not run after reset()", async () => {
      const { t, llm } = await startWithQueuedTurn();
      t.reset?.();
      // The queued turn carries pre-reset user text: it must not run into the
      // fresh history.
      await vi.advanceTimersByTimeAsync(50);
      expect(llm.calls.length).toBe(1);
      await t.stop();
    });

    test("a turn queued behind an active one does not run after cancelReply()", async () => {
      const { t, llm } = await startWithQueuedTurn();
      t.cancelReply();
      await vi.advanceTimersByTimeAsync(50);
      expect(llm.calls.length).toBe(1);
      await t.stop();
    });

    test("reset() discards the aborted turn's interrupted-turn persistence", async () => {
      const llm = createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 });
      const { opts, stt, tts } = makeOpts({ llm });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("question");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });

      t.reset?.();
      await vi.advanceTimersByTimeAsync(50);
      // persistInterruptedTurn runs after the abort settles; post-reset it must
      // not push the `[interrupted]` tail into the just-cleared history. Read
      // through a follow-up turn's LLM request rather than the transcript
      // callback — that callback is no longer part of this path at all (see
      // "no agent_transcript after cancelled" below), so asserting on it would
      // pass whether or not the reset was honoured.
      stt.last()?.fireFinal("fresh question");
      await vi.waitFor(() => {
        if (llm.calls.length !== 2) throw new Error("follow-up turn not started");
      });
      expect(JSON.stringify(llm.calls.at(-1))).not.toContain("[interrupted]");
      await t.stop();
    });

    test("cancelReply() still records the interrupted reply", async () => {
      // Contrast with reset(): a client cancel means "stop responding", not
      // "forget the conversation" — the text the caller HEARD stays in history,
      // so the next turn's LLM request carries it marked `[interrupted]`. The
      // reply has to actually reach the caller's ear for that: audio forwarded
      // and played out on the injected clock.
      const clock = createTestClock();
      const llm = createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 });
      const { opts, stt, tts } = makeOpts({ llm, heardLagMs: 0, heardNow: clock.now });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("question");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      speakFor(tts, clock, 2000);

      t.cancelReply();
      stt.last()?.fireFinal("follow up question");
      await vi.waitFor(() => {
        if (llm.calls.length !== 2) throw new Error("follow-up turn not started");
      });
      expect(JSON.stringify(llm.calls.at(-1))).toContain("[interrupted]");
      await t.stop();
    });

    describe("history records what was HEARD", () => {
      // The reply the specs below script, streamed one word at a time and
      // padded so it cannot run to completion before the barge-in lands (a
      // COMPLETED turn commits its full text — the same race
      // `inFlightReplyScript` exists for).
      const replyWords = [
        ..."Your balance is five hundred dollars and change today.".split(" "),
        ...Array.from({ length: 100 }, (_, i) => `filler${i}`),
      ];
      const REPLY = replyWords.map((w) => `${w} `).join("");
      const replyScript = replyWords.map((w) => ({ type: "text" as const, text: `${w} ` }));

      /**
       * Run one interrupted turn: `heardMs` of the four seconds of forwarded
       * audio plays out, then a barge-in cuts it. Returns the text that reached
       * TTS and the assistant text the NEXT turn's LLM request carries for the
       * interrupted one (empty when none was recorded).
       *
       * `settleDelayMs` advances the clock between the abort and the aborted
       * stream settling — the window the cut position has to survive.
       */
      async function interruptedRecord(
        heardMs: number,
        settleDelayMs = 0,
      ): Promise<{ recorded: string; spoken: string }> {
        const clock = createTestClock();
        const { opts, stt, tts } = makeOpts({
          heardLagMs: 0,
          heardNow: clock.now,
          minBargeInWords: 1,
          llm: createFakeLanguageModel({
            steps: [replyScript, [{ type: "text", text: "Sure." }]],
            delayMs: 5,
          }),
        });
        const t = createPipelineTransport(opts);
        await t.start();
        const llm = llmCalls(opts);

        stt.last()?.fireFinal("what is my balance");
        await vi.waitFor(() => {
          if ((tts.last()?.textChunks ?? []).join("").length <= 30) {
            throw new Error("not enough text reached TTS yet");
          }
        });
        // Four seconds of synthesized audio in the client's buffer, of which
        // `heardMs` has actually played.
        speakFor(tts, clock, 4000, heardMs);
        const callsBefore = llm.calls.length;
        const spoken = (tts.last()?.textChunks ?? []).join("");
        stt.last()?.firePartial("stop");
        clock.advance(settleDelayMs);

        stt.last()?.fireFinal("never mind");
        await vi.waitFor(() => {
          if (llm.calls.length <= callsBefore) throw new Error("follow-up turn not started");
        });
        const prompt = JSON.stringify(llm.calls.at(-1)?.prompt);
        await t.stop();
        return { spoken, recorded: prompt.match(/"text":"([^"]*) \[interrupted\]"/)?.[1] ?? "" };
      }

      test("a partly heard reply records the prefix the caller heard, not the tail", async () => {
        // A quarter of the forwarded audio played, so about a quarter of the
        // words did.
        const { recorded, spoken } = await interruptedRecord(1000);
        expect(recorded.length).toBeGreaterThan(0);
        // A real prefix of what the model generated...
        expect(REPLY.startsWith(recorded)).toBe(true);
        // ...and well short of everything that reached the synthesizer.
        expect(recorded.length).toBeLessThan(spoken.length / 2);
      });

      test("a reply cut before anything was audible records nothing at all", async () => {
        // Audio was forwarded — so the agent counts as speaking and the barge-in
        // fires — but none of it had reached the ear. LiveKit's rule: the reply
        // may as well not have happened.
        const { recorded, spoken } = await interruptedRecord(0);
        expect(spoken.length).toBeGreaterThan(30);
        expect(recorded).toBe("");
      });

      test("THE LATCH: the cut position survives the abort that resets the clock", async () => {
        // persistInterruptedTurn runs when the aborted stream settles, well
        // after `abortInFlightTurn` restarted the playback clock. Without
        // `heard.cut()` latching the position first, that read sees a clock with
        // nothing left to play and reports the reply as fully heard — today's
        // behaviour, which every other spec in this file still passes.
        const { recorded, spoken } = await interruptedRecord(500, 30_000);
        expect(recorded.length).toBeGreaterThan(0);
        expect(recorded.length).toBeLessThan(spoken.length / 2);
      });
    });

    test("no agent_transcript is emitted after the barge-in's cancelled frame", async () => {
      // The client ends the reply on `cancelled` — aai-ui commits the live
      // agent bubble into the conversation there. A transcript arriving after it
      // (persistInterruptedTurn used to send one when the aborted stream
      // settled, ~1ms later) does not amend that message: it opens a fresh live
      // bubble for a reply that is over, which the next reply's close commits a
      // SECOND time. Measured on tau2-bench retail as 19 duplicated replies in
      // 73 cancels. Every word is already on the wire as an interim snapshot, so
      // the frame is redundant as well as harmful.
      const llm = createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 });
      const { opts, stt, tts, callbacks } = makeOpts({ llm });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("question");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      tts.last()?.fireAudio(new Int16Array(2400));

      const transcriptsBefore = vi.mocked(callbacks.reported("agent-transcript.committed")).mock
        .calls.length;
      stt.last()?.firePartial("actually stop");
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
      // Well past the aborted stream settling, which is when the frame used to
      // arrive; the interim snapshots (onAgentTranscriptPartial) are unaffected.
      await vi.advanceTimersByTimeAsync(80);
      expect(vi.mocked(callbacks.reported("agent-transcript.committed")).mock.calls.length).toBe(
        transcriptsBefore,
      );
      await t.stop();
    });
  });
});
