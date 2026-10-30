// Copyright 2026 the AAI authors. MIT license.
// What the CALLER gets when the LLM stalls: a bounded cover that ends honestly,
// and one answer to everything they said while waiting.
//
// The measured case (tau2-bench voice, eight sessions on one rate-limited
// Cerebras key): a turn sat silent for ~60 s, the dead-air cover looped "I'm
// still checking on this" for minutes, and when the model came back the turns
// the caller had queued in the meantime were answered one by one — six replies
// in about two seconds on one session.

import { DEFAULT_ERROR_PHRASE } from "@alexkroman1/aai/internal";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../../_pipeline-test-fakes.ts";
import { llmCalls, makeOpts, spoken, useVirtualTime } from "../_pipeline-transport-harness.ts";
import { DEAD_AIR_COVER_MAX_FILLERS } from "./reply/index.ts";
import { createPipelineTransport } from "./transport.ts";

useVirtualTime();

/** A model that opens no response at all until the request is aborted. */
function silentModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: ({ abortSignal }) =>
      new Promise((_, reject) => {
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
      }),
  });
}

describe("PipelineTransport — a stalled LLM", () => {
  test("the dead-air cover gives up after a bounded run and speaks errorPhrase", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: silentModel(),
      // Short windows so the cover's whole run fits well inside the stall clock.
      deadAirCoverMs: 100,
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("where is my order");
    // Fillers at 100, 300, 700 and 1500 ms; the give-up one window on, at 3100.
    await vi.advanceTimersByTimeAsync(4000);
    const heard = spoken(tts);
    expect(heard).toContain(DEFAULT_ERROR_PHRASE);
    // Every filler came BEFORE the apology, and there were no more of them.
    const fillers = heard.slice(0, heard.indexOf(DEFAULT_ERROR_PHRASE));
    expect(fillers.split(".").filter((s) => s.trim() !== "")).toHaveLength(
      DEAD_AIR_COVER_MAX_FILLERS,
    );
    expect(callbacks.reported("error.reported")).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("abandoned") }),
    );
    // And the line goes quiet afterwards: nothing more is said into the wait.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spoken(tts)).toBe(heard);
    await t.stop();
  });

  test("caller turns queued behind a slow reply are answered ONCE, against all of them", async () => {
    const llm = createFakeLanguageModel({
      steps: [[{ type: "text", text: "Let me look." }], [{ type: "text", text: "Here it is." }]],
      delayMs: 500,
    });
    const { opts, stt, callbacks } = makeOpts({ llm, deadAirCoverMs: 0 });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("where is my order");
    await vi.advanceTimersByTimeAsync(0);
    expect(llmCalls(opts).calls).toHaveLength(1);
    // The reply has not spoken, so none of these barge in: each one queues.
    stt.last()?.fireFinal("hello?");
    stt.last()?.fireFinal("are you there?");
    stt.last()?.fireFinal("it is order 1234");
    await vi.advanceTimersByTimeAsync(5000);

    const { calls } = llmCalls(opts);
    expect(calls).toHaveLength(2);
    const prompt = (calls[1]?.prompt ?? []) as { role: string; content: unknown }[];
    const users = prompt.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
    // One user message holding all three, after the first turn's.
    expect(users).toHaveLength(2);
    expect(users[1]).toContain("hello? are you there? it is order 1234");
    // Each utterance was still committed to the client as it was said.
    expect(callbacks.reported("userTranscript.committed")).toHaveBeenCalledTimes(4);
    expect(callbacks.reported("reply.completed")).toHaveBeenCalledTimes(2);
    await t.stop();
  });

  test("a turn that already started is not joined — the next utterance gets its own", async () => {
    const llm = createFakeLanguageModel({
      steps: [[{ type: "text", text: "One." }], [{ type: "text", text: "Two." }]],
      delayMs: 500,
    });
    const { opts, stt } = makeOpts({ llm, deadAirCoverMs: 0 });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("first");
    await vi.advanceTimersByTimeAsync(5000);
    stt.last()?.fireFinal("second");
    await vi.advanceTimersByTimeAsync(5000);
    expect(llmCalls(opts).calls).toHaveLength(2);
    await t.stop();
  });

  test("an utterance after cancelReply() is not lost to the stranded queued turn", async () => {
    const llm = createFakeLanguageModel({
      steps: [[{ type: "text", text: "Let me look." }], [{ type: "text", text: "Sure." }]],
      delayMs: 500,
    });
    const { opts, stt } = makeOpts({ llm, deadAirCoverMs: 0 });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("where is my order");
    await vi.advanceTimersByTimeAsync(0);
    stt.last()?.fireFinal("hello?");
    // Strands the queued "hello?" turn; what the caller says next must not
    // join it, or it would never be answered.
    t.cancelReply();
    stt.last()?.fireFinal("never mind, cancel it");
    await vi.advanceTimersByTimeAsync(5000);
    const { calls } = llmCalls(opts);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.prompt)).toContain("never mind, cancel it");
    await t.stop();
  });
});
