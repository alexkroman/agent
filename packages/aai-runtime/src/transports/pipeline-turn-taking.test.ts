// Copyright 2026 the AAI authors. MIT license.
// End-to-end wiring of the three turn-taking layers that sit OVER the
// thresholds — the regex-keyed endpointing table, the start-speaking floor
// and the post-interruption backoff. The policies themselves are unit-tested
// next door (`pipeline-endpointing.test.ts`, `pipeline-speak-gate.test.ts`,
// and the phrase lists in `pipeline-user-speech.test.ts`); what this file
// covers is that the transport really reaches them — the half that was wrong
// in every "the knob did nothing" bug this repo has recorded.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import { inFlightReplyScript, makeOpts, useVirtualTime } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

const WINDOW = { minTurnSilenceMs: 1600, maxTurnSilenceMs: 3500 };

describe("the endpointing table reaches the STT session", () => {
  test("a matching rule pushes its window; the utterance ending puts it back", async () => {
    const { opts, stt } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      sttEndpointing: WINDOW,
      endpointingRules: [{ type: "user", regex: "\\d\\s*$", timeoutMs: 2600 }],
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial("my zip is one nine");
    expect(stt.last()?.updateEndpointing).not.toHaveBeenCalled();

    stt.last()?.firePartial("my zip is 19122");
    expect(stt.last()?.updateEndpointing).toHaveBeenCalledWith(2600);

    stt.last()?.fireFinal("my zip is 19122");
    expect(stt.last()?.updateEndpointing).toHaveBeenLastCalledWith(1600);
    await t.stop();
  });

  test("an assistant rule reads the reply the agent just gave", async () => {
    const { opts, stt, tts } = makeOpts({
      llm: createFakeLanguageModel({
        script: [{ type: "text", text: "What's your order number?" }],
      }),
      sttEndpointing: WINDOW,
      endpointingRules: [{ type: "assistant", regex: "order number", timeoutMs: 2600 }],
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("I need help");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
    });
    // Nothing pushed yet: the caller has not spoken since, so the table has
    // not been re-read.
    stt.last()?.firePartial("it's");
    expect(stt.last()?.updateEndpointing).toHaveBeenCalledWith(2600);
    await t.stop();
  });

  test("no table means no frames at all", async () => {
    const { opts, stt } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      sttEndpointing: WINDOW,
      endpointingRules: [],
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.firePartial("19122");
    stt.last()?.fireFinal("19122");
    expect(stt.last()?.updateEndpointing).not.toHaveBeenCalled();
    await t.stop();
  });
});

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
