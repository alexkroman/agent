// Copyright 2026 the AAI authors. MIT license.
// What a `dialog()` state's voice knobs DO once they reach the pipeline: the
// two barge-in gates and the two per-step LLM settings. Which knobs get this
// far, and why the other two cannot, is `pipeline-dialog-knobs.ts`; that they
// are read fresh is `pipeline-dialog-knobs.test.ts`. These are the specs that
// say the transport actually behaves differently.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import {
  inFlightReplyScript,
  llmCalls,
  makeOpts,
  noopToolSchema,
  useVirtualTime,
} from "./_pipeline-transport-harness.ts";
import type { DialogTurnKnobs } from "./pipeline-dialog-knobs.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

describe("a state's bargeIn", () => {
  test('"off" lets the agent FINISH: no partial and no final interrupts it', async () => {
    // The disclosure case. `minBargeInWords: Infinity` is what
    // `bargeIn: "off"` translates to, and both gates are `words >= threshold`.
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 }),
      minBargeInWords: 1,
      dialogTurn: () => ({ minBargeInWords: Number.POSITIVE_INFINITY }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("read me the terms");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
    });
    tts.last()?.fireAudio(new Int16Array(2400)); // the agent is now speaking

    stt.last()?.firePartial("wait stop hold on");
    stt.last()?.fireFinal("wait stop hold on");

    expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();
    expect(tts.last()?.cancel).not.toHaveBeenCalled();
    await t.stop();
  });

  test("is read at the moment a partial is classified, so a phase change takes effect", async () => {
    // The whole reason this is a thunk: the dialog moves between turns, and a
    // threshold captured at transport construction would pin the call to
    // whatever state the first turn started in.
    let knobs: DialogTurnKnobs | undefined = { minBargeInWords: Number.POSITIVE_INFINITY };
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 }),
      dialogTurn: () => knobs,
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("read me the terms");
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
    });
    tts.last()?.fireAudio(new Int16Array(2400));

    stt.last()?.firePartial("wait now");
    expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();

    // The disclosure ended; the dialog is somewhere interruptible again.
    knobs = { minBargeInWords: 2 };
    stt.last()?.firePartial("wait now please");

    expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
    await t.stop();
  });
});

describe("a state's toolChoice and temperature", () => {
  test("reach the request, over the agent's own settings", async () => {
    const { opts, stt } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
      toolChoice: "auto",
      temperature: 0.9,
      dialogTurn: () => ({ toolChoice: "none", temperature: 0.1 }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("hello");
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(1);
    });

    const call = llmCalls(opts).calls[0];
    expect(call?.temperature).toBe(0.1);
    expect(call?.toolChoice).toEqual({ type: "none" });
    await t.stop();
  });

  test("a state that declares neither leaves the agent's own settings alone", async () => {
    const { opts, stt } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
      temperature: 0.9,
      // A dialog present for its BARGE-IN alone must not reset the other two.
      dialogTurn: () => ({ minBargeInWords: 4 }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("hello");
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(1);
    });

    expect(llmCalls(opts).calls[0]?.temperature).toBe(0.9);
    await t.stop();
  });

  test("beat an agent-level `required` on EVERY step, not just the first", async () => {
    // Three scopes on one key, and the middle one is the state's. An agent-level
    // demanding `toolChoice` is put back to `"auto"` after step 0
    // (`resetToolChoiceAfterFirstStep`), which shares the key this preparer
    // writes — so composed in the wrong order the reset wins from step 1 on and
    // a state that pins a tool silently stops meaning it after the first step
    // of every turn. `ToolChoice`'s scope list is what says the state wins:
    // agent → turn → dialog state → forced final step.
    const { opts, stt } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "tc-1", toolName: "lookup", input: "{}" }],
          [{ type: "tool-call", toolCallId: "tc-2", toolName: "lookup", input: "{}" }],
          [{ type: "text", text: "all set" }],
        ],
      }),
      toolChoice: "required",
      toolSchemas: [noopToolSchema],
      executeTool: async () => "ok",
      dialogTurn: () => ({ toolChoice: { type: "tool", toolName: "lookup" } }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.fireFinal("look it up");
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(3);
    });

    // maxSteps defaults to 10, so `forceFinalAnswer` fires on none of these —
    // every step here is the state's to pin.
    const pinned = { type: "tool", toolName: "lookup" };
    expect(llmCalls(opts).calls[0]?.toolChoice).toEqual(pinned);
    expect(llmCalls(opts).calls[1]?.toolChoice).toEqual(pinned);
    expect(llmCalls(opts).calls[2]?.toolChoice).toEqual(pinned);
    await t.stop();
  });
});

describe("preemptive generation", () => {
  test("is OFF for a session whose dialogs vary the LLM knobs", async () => {
    // The speculation decides ONCE, from the session's `toolChoice`, whether
    // speculating is free at all — so a state that pins a tool would make every
    // speculation end at the tool boundary with the gate still believing it was
    // free. Off is the honest answer; the knobs are what an author asked for.
    const { opts, stt } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
      preemptiveGeneration: true,
      dialogTurn: () => ({ toolChoice: "required" }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    // A high-confidence interim is what launches one when the feature is live.
    stt.last()?.firePartial("book me a table", { endOfTurnConfidence: 0.99 });
    await vi.advanceTimersByTimeAsync(50);

    expect(llmCalls(opts).calls).toHaveLength(0);
    await t.stop();
  });
});
