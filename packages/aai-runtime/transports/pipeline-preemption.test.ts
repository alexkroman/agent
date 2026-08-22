// Copyright 2026 the AAI authors. MIT license.
// Transport-level specs for preemptive generation: the two structural
// guardrails (no speculative speech, no speculative tool execution), adoption,
// the mismatch re-run, the no-trace property, recovery, and the shipped default
// being ON (plus the explicit opt-out). The policy rules live in
// pipeline-speculation.test.ts.

import type { ModelMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { flush } from "../_test-utils.ts";
import {
  llmCalls,
  makeOpts,
  noopToolSchema,
  useVirtualTime,
} from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

/** High enough to clear PREEMPTIVE_CONFIDENCE_THRESHOLD however it is retuned. */
const CERTAIN = { endOfTurnConfidence: 1 };
const UTTERANCE = "what is my order status";

/** Prompt messages of a recorded `doStream` call. */
function promptOf(call: { prompt?: unknown }): ModelMessage[] {
  return (call.prompt ?? []) as ModelMessage[];
}

/**
 * The text of every user message in a recorded request. Provider-level prompts
 * carry content as parts, so this flattens them back to the string the turn was
 * committed with.
 */
function userTexts(call: { prompt?: unknown }): string[] {
  return promptOf(call)
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")
            .trim(),
    );
}

useVirtualTime();

describe("preemptive generation — guardrail 1: nothing speculative is ever spoken", () => {
  test("a high-confidence partial generates but sends no TTS text, audio, or client frame", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({
      preemptiveGeneration: true,
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Your order shipped." }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial(UTTERANCE, CERTAIN);
    // Wait until the speculation is demonstrably streaming, so the assertions
    // below run after it started rather than before.
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(tts.last()?.sendText).not.toHaveBeenCalled();
    expect(callbacks.onAudioChunk).not.toHaveBeenCalled();
    expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
    expect(callbacks.reported("agent-transcript.updated")).not.toHaveBeenCalled();
    expect(callbacks.reported("tool.called")).not.toHaveBeenCalled();
    await t.stop();
  });
});

describe("preemptive generation — guardrail 2: nothing speculative executes a tool", () => {
  test("a tool-calling script never executes during the speculation, and is discarded whole", async () => {
    const executeTool = vi.fn(async () => "shipped");
    const { opts, stt, tts } = makeOpts({
      preemptiveGeneration: true,
      toolSchemas: [noopToolSchema],
      executeTool,
      // The speculation consumes the first scripted step, so the tool-calling
      // step is scripted TWICE: the real turn must be able to reach it again
      // from scratch, which is exactly what "discarded whole" means.
      llm: createFakeLanguageModel({
        steps: [
          [
            { type: "text", text: "Let me check. " },
            { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" },
          ],
          [
            { type: "text", text: "Let me check. " },
            { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" },
          ],
          [{ type: "text", text: "It shipped yesterday." }],
        ],
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial(UTTERANCE, CERTAIN);
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(20);
    // The declaration-only tool set means the SDK cannot continue past the
    // call, so there is nothing to execute and nothing was spoken either.
    expect(executeTool).not.toHaveBeenCalled();
    expect(tts.last()?.sendText).not.toHaveBeenCalled();

    stt.last()?.fireFinal(UTTERANCE);
    await vi.waitFor(() => {
      expect(executeTool).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect((tts.last()?.textChunks ?? []).join("")).toContain("It shipped yesterday.");
    });
    // The real turn re-ran the request from scratch, against the FINAL text.
    expect(llmCalls(opts).calls.length).toBeGreaterThanOrEqual(2);
    expect(userTexts(llmCalls(opts).calls[1] as { prompt?: unknown })).toContain(UTTERANCE);
    await t.stop();
  });
});

describe("preemptive generation — adoption", () => {
  test("a matching final adopts the running stream: ONE request, the usual wire order", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({
      preemptiveGeneration: true,
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Your order shipped." }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial(UTTERANCE, CERTAIN);
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(1);
    });
    expect(tts.last()?.sendText).not.toHaveBeenCalled();

    stt.last()?.fireFinal("What is my order status?");
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalledTimes(1);
    });

    // The head start was real generation, not a second request.
    expect(llmCalls(opts).calls).toHaveLength(1);
    expect((tts.last()?.textChunks ?? []).join("")).toContain("Your order shipped.");
    expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(1);
    await t.stop();
  });

  test("REQUEST PARITY: the adopted request is what the ordinary path would have sent", async () => {
    // The premise adoption rests on. A future `streamText` parameter added to
    // one path only would make an adopted turn run under different settings,
    // and `startLlmStream` being the single assembler is the whole defence.
    const script = [{ type: "text" as const, text: "Your order shipped." }];
    const runs: Record<string, unknown>[] = [];
    for (const preemptiveGeneration of [false, true]) {
      const { opts, stt, callbacks } = makeOpts({
        preemptiveGeneration,
        llm: createFakeLanguageModel({ script }),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      if (preemptiveGeneration) {
        stt.last()?.firePartial(UTTERANCE, CERTAIN);
        await vi.waitFor(() => {
          expect(llmCalls(opts).calls).toHaveLength(1);
        });
      }
      stt.last()?.fireFinal(UTTERANCE);
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalledTimes(1);
      });
      expect(llmCalls(opts).calls).toHaveLength(1);
      runs.push(llmCalls(opts).calls[0] as Record<string, unknown>);
      await t.stop();
    }
    const [plain, adopted] = runs as [Record<string, unknown>, Record<string, unknown>];
    // Compared field by field rather than whole-object: `abortSignal` and
    // `includeRawChunks`-style handles are per-run objects that can never be
    // equal, while everything that DECIDES the generation must be.
    for (const key of ["prompt", "tools", "toolChoice", "temperature"]) {
      expect(adopted[key]).toStrictEqual(plain[key]);
    }
  });
});

describe("preemptive generation — mismatch", () => {
  test("a final that extends the partial re-runs the turn against the FINAL text", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({
      preemptiveGeneration: true,
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "text", text: "Speculated answer." }],
          [{ type: "text", text: "Real answer." }],
        ],
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial(UTTERANCE, CERTAIN);
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(1);
    });

    const final = `${UTTERANCE} please`;
    stt.last()?.fireFinal(final);
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalledTimes(1);
    });

    expect(llmCalls(opts).calls).toHaveLength(2);
    expect(userTexts(llmCalls(opts).calls[1] as { prompt?: unknown })).toContain(final);
    expect((tts.last()?.textChunks ?? []).join("")).toContain("Real answer.");
    expect((tts.last()?.textChunks ?? []).join("")).not.toContain("Speculated answer.");
    // The client sees exactly one reply.
    expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(1);
    await t.stop();
  });
});

describe("preemptive generation — no trace", () => {
  test("a discarded speculation leaves both history views untouched", async () => {
    const { opts, stt, callbacks } = makeOpts({
      preemptiveGeneration: true,
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "text", text: "Speculated answer." }],
          [{ type: "text", text: "Real answer." }],
        ],
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial(UTTERANCE, CERTAIN);
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(20);
    stt.last()?.firePartial("something else entirely", CERTAIN);
    await flush();

    // The next real turn's request is the load-bearing assertion: an equal
    // history LENGTH could still hold the wrong string.
    stt.last()?.fireFinal("tell me a joke");
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalledTimes(1);
    });
    const last = llmCalls(opts).calls.at(-1) as { prompt?: unknown };
    expect(userTexts(last)).toEqual(["tell me a joke"]);
    expect(JSON.stringify(promptOf(last))).not.toContain("Speculated answer.");
    await t.stop();
  });
});

describe("preemptive generation — recovery cannot resume a speculation", () => {
  test("an utterance that never commits discards the speculation and runs no turn", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({
      preemptiveGeneration: true,
      // Short enough that the watchdog fires inside the spec.
      speechIdleTimeoutMs: 30,
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Speculated answer." }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial(UTTERANCE, CERTAIN);
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(1);
    });
    // Let the speaking edge go idle — the false-interruption resume signal.
    await vi.advanceTimersByTimeAsync(80);

    expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
    expect(tts.last()?.sendText).not.toHaveBeenCalled();
    // And the discarded speculation cannot be adopted by a later, unrelated turn.
    stt.last()?.fireFinal(UTTERANCE);
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalledTimes(1);
    });
    expect(llmCalls(opts).calls).toHaveLength(2);
    await t.stop();
  });
});

describe("preemptive generation — OFF by default", () => {
  test("a transport that configures NOTHING does not speculate", async () => {
    // The shipped default, end to end: `pipeline-transport-options.test.ts`
    // pins the resolver, this pins that the resolved value actually reaches the
    // speculation controller. `preemptiveGeneration: undefined` is written
    // explicitly because it is the state a real agent that sets no tuning field
    // arrives in — the resolver's `?? false` is the only thing deciding here.
    // Measured off: +8ms per caller turn, 44% of its LLM requests discarded.
    const { opts, stt, callbacks } = makeOpts({
      preemptiveGeneration: undefined,
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Your order shipped." }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    // A high-confidence partial buys no request on the default path.
    stt.last()?.firePartial(UTTERANCE, CERTAIN);
    await flush();
    expect(llmCalls(opts).calls).toHaveLength(0);
    expect(callbacks.onReplyStarted).not.toHaveBeenCalled();

    // The turn still costs exactly one request — issued by the FINAL, not
    // before it, which is the whole difference the default makes.
    stt.last()?.fireFinal(UTTERANCE);
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalledTimes(1);
    });
    expect(llmCalls(opts).calls).toHaveLength(1);
    await t.stop();
  });

  test("`preemptiveGeneration: false` opts out: the high-confidence partial generates nothing", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({
      preemptiveGeneration: false,
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Your order shipped." }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial(UTTERANCE, CERTAIN);
    await vi.advanceTimersByTimeAsync(30);
    expect(llmCalls(opts).calls).toHaveLength(0);

    // And the ordinary turn is byte-identical to what it always was.
    stt.last()?.fireFinal(UTTERANCE);
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalledTimes(1);
    });
    expect(llmCalls(opts).calls).toHaveLength(1);
    expect((tts.last()?.textChunks ?? []).join("")).toContain("Your order shipped.");
    await t.stop();
  });

  test('`toolChoice: "required"` makes the flag inert', async () => {
    const { opts, stt } = makeOpts({
      preemptiveGeneration: true,
      toolChoice: "required",
      toolSchemas: [noopToolSchema],
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.firePartial(UTTERANCE, CERTAIN);
    await vi.advanceTimersByTimeAsync(30);
    expect(llmCalls(opts).calls).toHaveLength(0);
    await t.stop();
  });
});
