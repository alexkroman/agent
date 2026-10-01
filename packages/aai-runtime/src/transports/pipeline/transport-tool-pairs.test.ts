// Copyright 2026 the AAI authors. MIT license.
// A turn that leaves a tool call without a result must not break the session.
//
// The production failure (tau2 retail, one session): a step ended on a tool
// call with an unsafe finish reason, so the AI SDK never executed it and the
// step's messages held the call ALONE. Persisted into history, it refused every
// later request with "Tool result is missing for tool call <id>." until the
// caller hung up. These specs drive that turn and then the NEXT one, and assert
// on what the model is actually sent — see `../../tools/call-pairs.ts`.
//
// The second block pins the other candidate paths (an invalid call, a fatal
// tool error, a barge-in mid-execution), which already leave a paired history:
// if one of them regresses, it fails here rather than in a caller's session.
//
// The third is the RESUME door: a rebuilt history's prior calls must reach the
// model as the same pairs, never as text (`modelHistoryOf`).

import type { SessionEventBody } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "../../_logger-test-utils.ts";
import { createFakeLanguageModel, type ScriptedPart } from "../../_pipeline-test-fakes.ts";
import { historyFromEvents, modelHistoryOf, stampSessionEvent } from "../../session/index.ts";
import { FatalToolError } from "../../tools/index.ts";
import {
  llmCalls,
  makeOpts,
  noopToolSchema,
  useVirtualTime,
} from "../_pipeline-transport-harness.ts";
import type { PipelineTransportOptions } from "./options.ts";
import { createPipelineTransport } from "./transport.ts";

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

describe("a RESUMED conversation's tool calls reach the model as pairs", () => {
  test("the request after a seed carries the call, its result under the same id, then the reply", async () => {
    // End to end through the transport: the session's event log, rebuilt
    // (`historyFromEvents`), rendered for the model (`modelHistoryOf`), seeded
    // (`seedHistory`), and read back off the provider request the next turn
    // makes. The digest text this replaced was imitated live — the model spoke
    // `[tool think(…) … to=functions.prepare_call …` instead of calling.
    const log: SessionEventBody[] = [
      { type: "userTranscript.committed", text: "where is my order" },
      { type: "tool.called", toolCallId: "tc-1", toolName: "lookup", args: { id: "4471" } },
      { type: "tool.completed", toolCallId: "tc-1", result: "eta=tue" },
      { type: "agentTranscript.committed", text: "Tuesday." },
    ];
    const { messages, toolCalls } = historyFromEvents(log.map((body) => stampSessionEvent(body)));
    const logger = makeLogger();
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ steps: [NEXT_REPLY] }),
      executeTool: vi.fn(async () => "result"),
      toolSchemas: [noopToolSchema],
      logger,
    });
    const t = createPipelineTransport(opts);
    await t.start();
    t.seedHistory?.(messages, modelHistoryOf(messages, toolCalls));
    stt.last()?.fireFinal("are you sure");
    await vi.waitFor(() => {
      expect(callbacks.reported("agentTranscript.committed")).toHaveBeenCalled();
    });
    const prompt = promptOf(llmCalls(opts).calls[0]).filter((m) => m.role !== "system");
    await t.stop();

    expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(idsOf(prompt, "tool-call")).toEqual(["tc-1"]);
    expect(idsOf(prompt, "tool-result")).toEqual(["tc-1"]);
    expect(partsOf(prompt[1] as PromptMessage)).toEqual([
      expect.objectContaining({ type: "tool-call", toolName: "lookup", input: { id: "4471" } }),
    ]);
    expect(resultFor(prompt, "tc-1")).toEqual({ type: "text", value: "eta=tue" });
    expect(unansweredCalls(prompt)).toEqual([]);
    expect(JSON.stringify(prompt)).not.toContain("[tool ");
    expect(logger.warn).not.toHaveBeenCalledWith("Orphaned tool result dropped", expect.anything());
  });
});
