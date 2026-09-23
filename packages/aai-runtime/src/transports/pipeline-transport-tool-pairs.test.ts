// Copyright 2026 the AAI authors. MIT license.
// A turn that leaves a tool call without a result must not break the session.
//
// The production failure (tau2 retail, one session): a step ended on a tool
// call with an unsafe finish reason, so the AI SDK never executed it and the
// step's messages held the call ALONE. Persisted into history, it refused every
// later request with "Tool result is missing for tool call <id>." until the
// caller hung up. These specs drive that turn and then the NEXT one, and assert
// on what the model is actually sent — see `../tool-call-pairs.ts`.
//
// The second block pins the other candidate paths (an invalid call, a fatal
// tool error, a barge-in mid-execution), which already leave a paired history:
// if one of them regresses, it fails here rather than in a caller's session.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, type ScriptedPart } from "../_pipeline-test-fakes.ts";
import { makeLogger } from "../_test-utils.ts";
import { FatalToolError } from "../tool-error-policy.ts";
import {
  llmCalls,
  makeOpts,
  noopToolSchema,
  useVirtualTime,
} from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";
import type { PipelineTransportOptions } from "./pipeline-transport-options.ts";

useVirtualTime();

type PromptPart = { type?: string; toolCallId?: string; output?: unknown };
type PromptMessage = { role: string; content: unknown };

/** The model-facing prompt of one recorded call. */
function promptOf(call: Record<string, unknown> | undefined): PromptMessage[] {
  return (call?.prompt ?? []) as PromptMessage[];
}

function partsOf(m: PromptMessage): PromptPart[] {
  return Array.isArray(m.content) ? (m.content as PromptPart[]) : [];
}

/** The `toolCallId` of every part of `type` in `prompt`. */
function idsOf(prompt: readonly PromptMessage[], type: string): string[] {
  return prompt.flatMap(partsOf).flatMap((p) => (p.type === type ? [p.toolCallId ?? ""] : []));
}

/** Ids of every tool call in `prompt` that no tool result answers. */
function unansweredCalls(prompt: readonly PromptMessage[]): string[] {
  const answered = new Set(idsOf(prompt, "tool-result"));
  return idsOf(prompt, "tool-call").filter((id) => !answered.has(id));
}

/** The result the model was handed for `id`, if any. */
function resultFor(prompt: readonly PromptMessage[], id: string): unknown {
  return prompt.flatMap(partsOf).find((p) => p.type === "tool-result" && p.toolCallId === id)
    ?.output;
}

const CALL: ScriptedPart = {
  type: "tool-call",
  toolCallId: "call_x9f",
  toolName: "lookup",
  input: "{}",
};
const NEXT_REPLY: ScriptedPart[] = [{ type: "text", text: "Here is what I found." }];

/** Run the scripted first turn, then a second one; answer both requests. */
async function twoTurns(
  first: ScriptedPart[][],
  overrides: Partial<PipelineTransportOptions> = {},
  midTurn?: (t: ReturnType<typeof createPipelineTransport>) => Promise<void>,
) {
  const log = makeLogger();
  const { opts, stt, callbacks } = makeOpts({
    llm: createFakeLanguageModel({ steps: [...first, NEXT_REPLY], delayMs: 10 }),
    executeTool: vi.fn(async () => "result"),
    toolSchemas: [noopToolSchema],
    logger: log,
    ...overrides,
  });
  const t = createPipelineTransport(opts);
  await t.start();
  stt.last()?.fireFinal("please look that up");
  await midTurn?.(t);
  await vi.advanceTimersByTimeAsync(2000);
  const callsAfterFirst = llmCalls(opts).calls.length;
  stt.last()?.fireFinal("all right, then");
  // Polled with a THROW rather than an `expect`: this is a helper, and the
  // assertion that matters is the caller's, on what the request carried.
  await vi.waitFor(() => {
    if (llmCalls(opts).calls.length <= callsAfterFirst) throw new Error("no second request yet");
  });
  await vi.advanceTimersByTimeAsync(500);
  const second = promptOf(llmCalls(opts).calls.at(-1));
  const errors = callbacks.reported("error.reported").mock.calls.map((c) => c[0]);
  await t.stop();
  return { second, errors, log };
}

describe("a tool call the SDK never executed", () => {
  test.each(["length", "other", "content-filter"])(
    "finish reason %s: the NEXT turn's request goes out, every call answered",
    async (reason) => {
      const { second, errors } = await twoTurns([[CALL, { type: "finish-reason", reason }]]);
      // Without the guard the SDK refuses this request before sending it, so
      // the model would never have been called a second time at all.
      expect(unansweredCalls(second)).toEqual([]);
      expect(resultFor(second, "call_x9f")).toEqual({
        type: "error-json",
        value: { error: "This tool call was not executed." },
      });
      expect(errors).toEqual([]);
    },
  );

  test("the repair and the unexecuted call are both logged, naming the finish reason", async () => {
    const { log } = await twoTurns([[CALL, { type: "finish-reason", reason: "length" }]]);
    expect(log.warn).toHaveBeenCalledWith("Orphaned tool call repaired", {
      sid: "test-sid",
      toolCallId: "call_x9f",
      toolName: "lookup",
    });
    expect(log.warn).toHaveBeenCalledWith("LLM turn ended with unexecuted tool calls", {
      sid: "test-sid",
      toolCalls: ["lookup"],
      unexecutedToolCalls: ["lookup"],
      finishReason: "length",
      rawFinishReason: "length",
    });
    expect(log.info).toHaveBeenCalledWith(
      "LLM turn",
      expect.objectContaining({ toolCalls: ["lookup"], unexecutedToolCalls: ["lookup"] }),
    );
  });
});

describe("the other candidate paths already leave a paired history", () => {
  test("a call to an unknown tool is answered with its error, and the reason is logged", async () => {
    const { second, log } = await twoTurns([
      [{ ...CALL, toolName: "no_such_tool" }],
      [{ type: "text", text: "Sorry." }],
    ]);
    expect(unansweredCalls(second)).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      "Tool call failed",
      expect.objectContaining({
        toolCallId: "call_x9f",
        toolName: "no_such_tool",
        error: expect.stringContaining("unavailable tool"),
      }),
    );
    expect(log.warn).not.toHaveBeenCalledWith("Orphaned tool call repaired", expect.anything());
  });

  test("a fatal tool error stops the turn without persisting its half-finished step", async () => {
    const executeTool = vi.fn(async () => {
      throw new FatalToolError("lookup", new Error("credential missing"));
    });
    const { second, log } = await twoTurns([[CALL]], { executeTool });
    expect(executeTool).toHaveBeenCalledOnce();
    expect(unansweredCalls(second)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalledWith("Orphaned tool call repaired", expect.anything());
  });

  test("a barge-in during tool execution persists no unanswered call", async () => {
    let aborted = false;
    const executeTool: PipelineTransportOptions["executeTool"] = (_n, _a, _s, _m, options) =>
      new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const { second, log } = await twoTurns(
      [[{ type: "text", text: "Let me check. " }, CALL]],
      { executeTool },
      async (t) => {
        await vi.advanceTimersByTimeAsync(100);
        t.cancelReply();
      },
    );
    // The abort really landed INSIDE the execution, which is the window at issue.
    expect(aborted).toBe(true);
    expect(unansweredCalls(second)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalledWith("Orphaned tool call repaired", expect.anything());
  });
});
