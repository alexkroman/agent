// Copyright 2026 the AAI authors. MIT license.
// The turnRunner seam: a pipeline transport whose reply source is pluggable
// (the eve integration) while every other voice path stays in place.

import { describe, expect, test, vi } from "vitest";
import { makeOpts } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";
import { resolvePipelineOptions } from "./pipeline-transport-options.ts";
import type { PipelineTurnArgs, PipelineTurnRunner } from "./pipeline-turn-runner.ts";

describe("resolvePipelineOptions — reply-source rule", () => {
  test("rejects a turnRunner alongside an llm", () => {
    const { opts } = makeOpts({ turnRunner: async () => ({ messages: [], failed: false }) });
    expect(() => resolvePipelineOptions(opts)).toThrow(/set llm: null/);
  });

  test("rejects llm: null without a turnRunner", () => {
    const { opts } = makeOpts({ llm: null });
    expect(() => resolvePipelineOptions(opts)).toThrow(/an llm is required/);
  });
});

describe("createPipelineTransport with a turnRunner", () => {
  test("a committed user turn runs through the runner, not streamText", async () => {
    const seen: PipelineTurnArgs[] = [];
    const runner: PipelineTurnRunner = vi.fn(async (args: PipelineTurnArgs) => {
      seen.push(args);
      args.onDelta("Hello from eve.");
      args.sendTtsText("Hello from eve.");
      return { messages: [], failed: false };
    });
    const { opts, stt, tts, callbacks } = makeOpts({ llm: null, turnRunner: runner });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("hi agent");
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(callbacks.onAgentTranscript).toHaveBeenCalled());

    const args = seen[0];
    expect(args?.userText).toBe("hi agent");
    expect(args?.systemPrompt).toBe("s");
    // The just-pushed user turn is visible in the LLM-view history.
    expect(args?.messages.at(-1)).toEqual({ role: "user", content: "hi agent" });
    // The reply reached both the transcript and the TTS provider.
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Hello from eve.", false);
    expect(tts.last()?.sendText).toHaveBeenCalledWith("Hello from eve.");
    await t.stop();
  });

  test("a failed runner turn speaks the recovery phrase", async () => {
    const runner: PipelineTurnRunner = async () => ({ messages: [], failed: true });
    const { opts, stt, tts } = makeOpts({
      llm: null,
      turnRunner: runner,
      errorPhrase: "Sorry, try again.",
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("hi");
    await vi.waitFor(() => expect(tts.last()?.sendText).toHaveBeenCalledWith("Sorry, try again."));
    await t.stop();
  });

  test("barge-in aborts the runner's turn via ctl.signal", async () => {
    let aborted = false;
    const runner: PipelineTurnRunner = async (args: PipelineTurnArgs) => {
      args.onDelta("Long ");
      args.sendTtsText("Long ");
      await new Promise<void>((resolve) => {
        args.ctl.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return { messages: [], failed: false };
    };
    const { opts, stt, tts } = makeOpts({ llm: null, turnRunner: runner });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("question");
    // The reply must have spoken (TTS audio on the wire) before an interim
    // transcript may interrupt it — mirror the real barge-in preconditions.
    await vi.waitFor(() => expect(tts.last()?.sendText).toHaveBeenCalled());
    tts.last()?.fireAudio(new Int16Array(1600));
    stt.last()?.firePartial("wait actually stop");
    await vi.waitFor(() => expect(aborted).toBe(true));
    await t.stop();
  });
});
