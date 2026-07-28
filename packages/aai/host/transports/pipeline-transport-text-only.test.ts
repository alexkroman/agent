// Copyright 2026 the AAI authors. MIT license.
// Text-only pipeline sessions (`tts: none()` → null TTS opener): the STT →
// LLM half runs unchanged, replies land as agent transcripts, and nothing in
// the turn lifecycle waits on a synthesis side that doesn't exist.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, type ScriptedPart } from "../_pipeline-test-fakes.ts";
import { makeOpts, noopToolSchema } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

/** makeOpts with the TTS side removed, as the runtime builds it for tts: none(). */
function makeTextOnlyOpts(overrides: Parameters<typeof makeOpts>[0] = {}) {
  const made = makeOpts({
    tts: null,
    providerKeys: { stt: "stt-key" },
    ...overrides,
  });
  return made;
}

describe("PipelineTransport (text-only)", () => {
  test("start() opens STT, fires onSessionReady, and stop() closes it", async () => {
    const { opts, stt, callbacks } = makeTextOnlyOpts();
    const t = createPipelineTransport(opts);
    await t.start();
    expect(stt.last()).toBeDefined();
    expect(callbacks.onSessionReady).toHaveBeenCalledWith("test-sid");
    await t.stop();
    expect(stt.last()?.closed.value).toBe(true);
  });

  test("greeting is emitted as a transcript with no audio", async () => {
    const { opts, callbacks } = makeTextOnlyOpts({
      sessionConfig: { systemPrompt: "s", greeting: "Hi there!" },
    });
    const t = createPipelineTransport(opts);
    await t.start();
    await vi.waitFor(() => {
      expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
    });
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Hi there!", false);
    expect(callbacks.onAudioChunk).not.toHaveBeenCalled();
    await t.stop();
  });

  test("a user turn streams the LLM reply as a transcript and completes without a TTS drain", async () => {
    const { opts, stt, callbacks } = makeTextOnlyOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Here is your answer." }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("what's the answer?");
    // If runReply waited on a TTS `done` that can never fire, this would burn
    // the full flush timeout instead of resolving promptly.
    await vi.waitFor(() => {
      expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
    });
    expect(callbacks.onUserTranscript).toHaveBeenCalledWith("what's the answer?");
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Here is your answer.", false);
    expect(callbacks.onAudioChunk).not.toHaveBeenCalled();
    await t.stop();
  });

  test("the hold phrase is forced off: a tool-call-first turn injects no filler text", async () => {
    const script: ScriptedPart[] = [
      { type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" },
      { type: "tool-result", toolCallId: "tc-1", toolName: "lookup", result: "42" },
      { type: "text", text: "It's 42." },
    ];
    const { opts, stt, callbacks } = makeTextOnlyOpts({
      llm: createFakeLanguageModel({ script }),
      toolSchemas: [noopToolSchema],
      executeTool: async () => "42",
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("look it up");
    await vi.waitFor(() => {
      expect(callbacks.onReplyDone).toHaveBeenCalled();
    });
    const transcripts = (callbacks.onAgentTranscript as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(transcripts.join(" ")).not.toContain("One moment");
    expect(transcripts.join(" ")).toContain("It's 42.");
    await t.stop();
  });

  test("cancelReply() and reset() tolerate the missing TTS side", async () => {
    const { opts } = makeTextOnlyOpts();
    const t = createPipelineTransport(opts);
    await t.start();
    expect(() => t.cancelReply()).not.toThrow();
    expect(() => t.reset?.()).not.toThrow();
    await t.stop();
  });
});
