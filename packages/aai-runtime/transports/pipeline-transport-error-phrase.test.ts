// Copyright 2026 the AAI authors. MIT license.
// What the CALLER hears when a turn's LLM stream fails: `errorPhrase`, spoken,
// flushed, captioned — and the error still reported to the client, non-fatally.
//
// Split out of `pipeline-transport.test.ts` at the seam it already had (this
// whole top-level `describe`), which was over the 700-line test cap. That file
// keeps lifecycle and config: start/stop, streamText plumbing, provider errors,
// tool observability, history seeding.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, type ScriptedPart } from "../_pipeline-test-fakes.ts";
import { makeOpts, useVirtualTime } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

describe("PipelineTransport — recovery when the LLM stream fails", () => {
  // A gateway 429/500 leaves the turn with no text, so nothing reaches TTS and
  // the caller hears silence — the only trace being a `llm` session error the
  // browser surfaces without a sound. The agent says so instead.
  const failingLlm = () =>
    createFakeLanguageModel({
      script: [{ type: "error", error: new Error("Internal Server Error") }],
    });

  test("speaks the error phrase", async () => {
    const { opts, stt, tts } = makeOpts({ llm: failingLlm() });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.join("")).toContain("Sorry, I had a problem");
    });
    await t.stop();
  });

  test("flushes TTS so the phrase is actually synthesized", async () => {
    // `runReply` skips drainTts for a turn that did not speak, and the drain is
    // what flushes the provider. AssemblyAI TTS synthesizes nothing until it is
    // flushed, so without this the "recovery" would itself be silence.
    const { opts, stt, tts } = makeOpts({ llm: failingLlm() });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(tts.last()?.flush).toHaveBeenCalled();
    });
    await t.stop();
  });

  test("emits the phrase as an agent transcript so the UI matches what was heard", async () => {
    const { opts, stt, callbacks } = makeOpts({ llm: failingLlm() });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
        type: "agent-transcript.committed",
        text: expect.stringContaining("Sorry, I had a problem"),
        // Tagged, so the caption can carry the phrase while no reader of the
        // stream records it — see `AgentTranscriptRecovery`.
        recovery: "turn-failed",
      });
    });
    await t.stop();
  });

  test("still reports the error to the client, NON-fatally", async () => {
    // Speaking to the caller is additive: a programmatic client must still see
    // that the turn failed rather than a normal-looking reply.
    //
    // And non-fatally, because the very next thing this transport does is speak
    // `errorPhrase` — "Could you say that again?" — and invite another turn.
    // `onError` defaults to fatal, which aai-ui answers by releasing the
    // microphone and ending the call, so the caller was asked to repeat
    // themselves into a session the client had already torn down.
    const { opts, stt, callbacks } = makeOpts({ llm: failingLlm() });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "llm",
        message: expect.any(String),
        fatal: false,
      });
    });
    await t.stop();
  });

  test("errorPhrase: '' disables the phrase but keeps the error", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({ llm: failingLlm(), errorPhrase: "" });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "llm",
        message: expect.any(String),
        fatal: false,
      });
    });
    expect(tts.last()?.textChunks.join("")).toBe("");
    await t.stop();
  });

  test("a custom errorPhrase is used verbatim", async () => {
    const { opts, stt, tts } = makeOpts({
      llm: failingLlm(),
      errorPhrase: "My brain just went offline.",
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.join("")).toContain("My brain just went offline.");
    });
    await t.stop();
  });

  test("does not speak the phrase for a successful turn", async () => {
    const script: ScriptedPart[] = [{ type: "text", text: "I am here." }];
    const { opts, stt, tts } = makeOpts({ llm: createFakeLanguageModel({ script }) });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("are you there?");

    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.join("")).toContain("I am here.");
    });
    expect(tts.last()?.textChunks.join("")).not.toContain("Sorry, I had a problem");
    await t.stop();
  });
});
