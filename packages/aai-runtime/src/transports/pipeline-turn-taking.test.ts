// Copyright 2026 the AAI authors. MIT license.
// End-to-end wiring of the two turn-taking layers that sit OVER the
// thresholds — the start-speaking floor and the post-interruption backoff.
// The policies themselves are unit-tested next door
// (`pipeline-speak-gate.test.ts`, and the phrase lists in
// `pipeline-user-speech.test.ts`); what this file covers is that the transport
// really reaches them — the half that was wrong in every "the knob did
// nothing" bug this repo has recorded.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import { inFlightReplyScript, makeOpts, useVirtualTime } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

describe("the start-speaking floor", () => {
  test("holds the first audio frame back, and the caller hears nothing until it passes", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "hello there" }] }),
      startSpeakingFloorMs: 400,
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("hi");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
    });
    tts.last()?.fireAudio(new Int16Array(240));
    expect(callbacks.onAudioChunk).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1);
    await t.stop();
  });

  test("0 — the shipped default — forwards audio in the same tick", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "hello there" }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("hi");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
    });
    tts.last()?.fireAudio(new Int16Array(240));
    expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1);
    await t.stop();
  });

  test("a caller speaking INSIDE the floor defers rather than barging in", async () => {
    // A consequence of the floor rather than a decision of its own, and worth
    // pinning because it is invisible: "the agent is speaking" means audio
    // has reached the caller, and inside the floor none has. So an utterance
    // in that window takes the deferral path every pre-audio utterance takes
    // (`createUserActivity`'s `agentIsSpeaking`, and the starvation argument
    // on it) — the held reply is still delivered, and the caller's turn is
    // answered after it.
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 }),
      startSpeakingFloorMs: 400,
      minBargeInWords: 1,
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("hi");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
    });
    tts.last()?.fireAudio(new Int16Array(240));
    stt.last()?.firePartial("actually cancel that");
    expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1);
    await t.stop();
  });
});

describe("the post-interruption backoff", () => {
  test("blocks the next reply's audio for the window, then releases it", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [inFlightReplyScript(), [{ type: "text", text: "sure, cancelled" }]],
        delayMs: 20,
      }),
      interruptionBackoffMs: 1000,
      minBargeInWords: 1,
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("hi");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
    });
    // The agent is audibly speaking, so the next utterance is a real barge-in.
    tts.last()?.fireAudio(new Int16Array(240));
    expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1);

    const chunksBefore = tts.last()?.textChunks.length ?? 0;
    stt.last()?.fireFinal("no, cancel it");
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
    });
    // The replacement reply has to reach TTS before its audio can be gated —
    // the turn's own audio gate is what a cancelled turn's late frames hit,
    // and it reopens on the next `sendTtsText`.
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(chunksBefore);
    });

    // Anything the replacement reply synthesizes inside the window waits.
    tts.last()?.fireAudio(new Int16Array(240));
    expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(2);
    await t.stop();
  });
});
