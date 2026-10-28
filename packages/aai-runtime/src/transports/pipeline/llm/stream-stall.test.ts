// Copyright 2026 the AAI authors. MIT license.
// A response stream that goes silent: the stall deadline and its one retry.
// Split from stream.test.ts, which sits near the test-file line cap.
//
// The measured case (tau2 retail task 104): the gateway answered `200`, sent
// its headers and then nothing, and the turn hung for 5 min until undici's body
// timeout — see LLM_STALL_TIMEOUT_MS.

import { tool } from "ai";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { silentLogger } from "../../../_logger-test-utils.ts";
import { createFakeLanguageModel } from "../../../_pipeline-test-fakes.ts";
import { consumeLlmStream } from "./stream.ts";

type ConsumeArgs = Parameters<typeof consumeLlmStream>[0];
type Model = ReturnType<typeof createFakeLanguageModel>;
type DoStream = (opts: { abortSignal?: AbortSignal }) => Promise<unknown>;

/**
 * Make the listed calls (0-based) of `llm.doStream` STALL: the response opens,
 * optionally says `prefix`, and then sends nothing until the request is
 * aborted — which errors the body, as a real fetch does. Every other call runs
 * the fake's own script.
 */
function stallOn(llm: Model, stalled: readonly number[], prefix?: string): { calls: () => number } {
  const target = llm as unknown as { doStream: DoStream };
  const original = target.doStream.bind(llm);
  let calls = 0;
  target.doStream = async (opts) => {
    const index = calls++;
    if (!stalled.includes(index)) return original(opts);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        if (prefix !== undefined) {
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: prefix });
        }
        opts.abortSignal?.addEventListener("abort", () =>
          controller.error(opts.abortSignal?.reason),
        );
      },
    });
    return { stream };
  };
  return { calls: () => calls };
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
    const llm = createFakeLanguageModel({
      script: [{ type: "text", text: "Your order shipped." }],
    });
    const { calls } = stallOn(llm, [0]);
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
    const llm = createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] });
    const { calls } = stallOn(llm, [0, 1]);
    const emitError = vi.fn();
    const result = await consume({ llm, emitError });
    expect(calls()).toBe(2);
    expect(result.failed).toBe(true);
    expect(emitError).toHaveBeenCalledWith("llm", expect.stringContaining("timeout"), {
      fatal: false,
    });
  });

  test("a stall after the model spoke is not re-sent — the caller would hear it twice", async () => {
    const llm = createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] });
    const { calls } = stallOn(llm, [0], "Okay, ");
    const result = await consume({ llm });
    expect(calls()).toBe(1);
    expect(result.failed).toBe(true);
  });

  test("a stall after a tool ran is not re-sent — the tool would run twice", async () => {
    const execute = vi.fn(async () => "cancelled");
    const llm = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "cancel_order", input: "{}" }],
        [{ type: "text", text: "Done." }],
      ],
    });
    const { calls } = stallOn(llm, [1]);
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
    const llm = createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] });
    const { calls } = stallOn(llm, [0]);
    const turn = new AbortController();
    setTimeout(() => turn.abort(), 10);
    const result = await consume({ llm, signal: turn.signal, stallTimeoutMs: 1000 });
    expect(calls()).toBe(1);
    expect(result.failed).toBe(false);
  });
});
