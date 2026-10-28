// Copyright 2026 the AAI authors. MIT license.
// A response stream that goes silent: the stall deadline and its one retry.
// Split from stream.test.ts, which sits near the test-file line cap.
//
// The measured case (tau2 retail task 104): the gateway answered `200`, sent
// its headers and then nothing, and the turn hung for 5 min until undici's body
// timeout — see LLM_STALL_TIMEOUT_MS.

import { sleep } from "@alexkroman1/aai/internal";
import { type LanguageModel, type LanguageModelMiddleware, tool, wrapLanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { silentLogger } from "../../../_logger-test-utils.ts";
import { createFakeLanguageModel } from "../../../_pipeline-test-fakes.ts";
import { consumeLlmStream } from "./stream.ts";

type ConsumeArgs = Parameters<typeof consumeLlmStream>[0];
type Model = ReturnType<typeof createFakeLanguageModel>;

/**
 * Make the listed calls (0-based) of the model's stream STALL: the response
 * opens, optionally says `prefix` (or reports `error`), and then sends nothing
 * until the request is aborted — which errors the body, as a real fetch does.
 * Every other call runs the fake's own script.
 */
function stallOn(
  fake: Model,
  stalled: readonly number[],
  prefix?: string,
  error?: Error,
): { llm: LanguageModel; calls: () => number } {
  if (typeof fake === "string") throw new Error("stallOn needs a model object");
  let calls = 0;
  const middleware: LanguageModelMiddleware = {
    wrapStream: async ({ doStream, params }) => {
      const index = calls++;
      if (!stalled.includes(index)) return doStream();
      const signal = params.abortSignal;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (prefix !== undefined) {
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: prefix });
          }
          if (error !== undefined) controller.enqueue({ type: "error", error });
          signal?.addEventListener("abort", () => controller.error(signal.reason));
        },
      });
      return { stream };
    },
  };
  return { llm: wrapLanguageModel({ model: fake, middleware }), calls: () => calls };
}

function consume(
  overrides: Partial<ConsumeArgs> & Pick<ConsumeArgs, "llm">,
): ReturnType<typeof consumeLlmStream> {
  return consumeLlmStream({
    sid: "s",
    systemPrompt: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: {},
    toolChoice: "auto",
    temperature: undefined,
    repairToolCall: async () => null,
    maxSteps: 1,
    sendTtsText: () => undefined,
    callbacks: { report: () => undefined },
    emitError: () => undefined,
    log: silentLogger,
    signal: new AbortController().signal,
    onDelta: () => undefined,
    stallTimeoutMs: 50,
    ...overrides,
  });
}

describe("consumeLlmStream — a stalled response", () => {
  test("a stall before any output is re-sent once, and the caller hears the answer", async () => {
    const fake = createFakeLanguageModel({
      script: [{ type: "text", text: "Your order shipped." }],
    });
    const { calls, llm } = stallOn(fake, [0]);
    const emitError = vi.fn();
    let spoken = "";
    const result = await consume({
      llm,
      emitError,
      onDelta: (d) => {
        spoken += d;
      },
    });
    expect(calls()).toBe(2);
    expect(result.failed).toBe(false);
    expect(spoken).toBe("Your order shipped.");
    // Recovered silently: no error reaches the client, so no apology.
    expect(emitError).not.toHaveBeenCalled();
  });

  test("a second stall fails the turn instead of retrying forever", async () => {
    const fake = createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] });
    const { calls, llm } = stallOn(fake, [0, 1]);
    const emitError = vi.fn();
    const result = await consume({ llm, emitError });
    expect(calls()).toBe(2);
    expect(result.failed).toBe(true);
    expect(emitError).toHaveBeenCalledWith("llm", expect.stringContaining("timeout"), {
      fatal: false,
    });
  });

  test("a stall after the model spoke is not re-sent — the caller would hear it twice", async () => {
    const fake = createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] });
    const { calls, llm } = stallOn(fake, [0], "Okay, ");
    const result = await consume({ llm });
    expect(calls()).toBe(1);
    expect(result.failed).toBe(true);
  });

  test("a stall after a tool ran is not re-sent — the tool would run twice", async () => {
    const execute = vi.fn(async () => "cancelled");
    const fake = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "cancel_order", input: "{}" }],
        [{ type: "text", text: "Done." }],
      ],
    });
    const { calls, llm } = stallOn(fake, [1]);
    const result = await consume({
      llm,
      maxSteps: 3,
      tools: { cancel_order: tool({ inputSchema: z.object({}), execute }) },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(calls()).toBe(2);
    expect(result.failed).toBe(true);
  });

  test("a barge-in during a stall ends the turn quietly, with no retry", async () => {
    const fake = createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] });
    const { calls, llm } = stallOn(fake, [0]);
    const turn = new AbortController();
    setTimeout(() => turn.abort(), 10);
    const result = await consume({ llm, signal: turn.signal, stallTimeoutMs: 1000 });
    expect(calls()).toBe(1);
    expect(result.failed).toBe(false);
  });

  test("a tool slower than the deadline runs to completion — tool time is not a stall", async () => {
    let toolSignal: AbortSignal | undefined;
    const execute = vi.fn(async (_input: unknown, opts: { abortSignal?: AbortSignal }) => {
      toolSignal = opts.abortSignal;
      await sleep(150);
      return "found";
    });
    const llm = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "web_search", input: "{}" }],
        [{ type: "text", text: "Here it is." }],
      ],
    });
    let spoken = "";
    const result = await consume({
      llm,
      maxSteps: 3,
      tools: { web_search: tool({ inputSchema: z.object({}), execute }) },
      onDelta: (d) => {
        spoken += d;
      },
    });
    expect(toolSignal?.aborted).toBe(false);
    expect(result.failed).toBe(false);
    expect(spoken).toBe("Here it is.");
  });

  test("a stall after an error part is not re-sent — the client was already told", async () => {
    const fake = createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] });
    const { calls, llm } = stallOn(fake, [0], undefined, new Error("upstream overloaded"));
    const emitError = vi.fn();
    const onLlmTiming = vi.fn();
    const result = await consume({ llm, emitError, onLlmTiming });
    expect(calls()).toBe(1);
    expect(result.failed).toBe(true);
    expect(emitError).toHaveBeenCalledTimes(1);
    expect(onLlmTiming).toHaveBeenCalledTimes(1);
  });

  test("a stall retry reports one timing for the turn, not one per pass", async () => {
    const fake = createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] });
    const { llm } = stallOn(fake, [0]);
    const onLlmTiming = vi.fn();
    const result = await consume({ llm, onLlmTiming });
    expect(result.failed).toBe(false);
    expect(onLlmTiming).toHaveBeenCalledTimes(1);
  });
});
