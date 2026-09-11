// Copyright 2026 the AAI authors. MIT license.
// `ToolDef.messages` through a real turn: `consumeLlmStream` over a scripted
// model, the real `toVercelTools` execute path and the real controller.
//
// The two claims that cannot be made one layer down. "`role: "assistant"`
// means the model is NOT CALLED" is a property of the step loop, so the
// assertion has to count the model's `doStream` calls; and "a tool covering
// its own gap silences the generic cover" is a property of two timers in
// different modules agreeing.

import type { ToolMessages } from "@alexkroman1/aai";
import { DEAD_AIR_OPENING_PHRASE, DEFAULT_DEAD_AIR_COVER_MS } from "@alexkroman1/aai/host-internal";
import { sleep } from "@alexkroman1/aai/internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { silentLogger } from "../_test-utils.ts";
import { toVercelTools } from "../to-vercel-tools.ts";
import { createToolSpeechController } from "../tool-messages-runner.ts";
import { useVirtualTime } from "./_pipeline-transport-harness.ts";
import { consumeLlmStream } from "./pipeline-llm-stream.ts";
import { createStreamPartHandler } from "./pipeline-stream-parts.ts";

function schemaWith(messages: ToolMessages): ToolSchema {
  return {
    type: "function",
    name: "lookup",
    description: "Look an order up.",
    parameters: { type: "object", properties: {}, required: [] },
    messages,
  };
}

/**
 * One turn in which the model calls `lookup` and, if it gets another step,
 * says `"model spoke"`.
 *
 * `executeTool` answers `result`, so the spec decides whether the call looks
 * like a success or a `ToolFailure` to the outcome arm.
 */
async function runTurn(messages: ToolMessages, result = '{"status":"shipped"}') {
  const spoken: { text: string; record: boolean }[] = [];
  const deltas: string[] = [];
  const controller = createToolSpeechController({ log: silentLogger, sid: "s", random: () => 0 });
  const llm = createFakeLanguageModel({
    steps: [
      [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" }],
      [{ type: "text", text: "model spoke" }],
    ],
  });
  const outcome = await consumeLlmStream({
    llm,
    systemPrompt: "s",
    messages: [{ role: "user", content: "where is my order" }],
    tools: toVercelTools([schemaWith(messages)], {
      executeTool: async () => result,
      sessionId: "s",
      messages: () => [],
      toolSpeech: controller,
    }),
    toolChoice: "auto",
    temperature: undefined,
    repairToolCall: async () => null,
    maxSteps: 3,
    // No cover in these specs: they are about the tool's own lines.
    deadAirCoverMs: 0,
    toolSpeech: controller,
    sendTtsText: (text, opts) => spoken.push({ text, record: opts?.record !== false }),
    callbacks: { report: () => undefined },
    emitError: () => undefined,
    log: silentLogger,
    sid: "s",
    signal: new AbortController().signal,
    onDelta: (delta) => deltas.push(delta),
  });
  return { outcome, spoken, deltas, modelCalls: llm.calls.length, controller };
}

describe("a verbatim completion takes the model out of the loop", () => {
  test('`role: "assistant"` speaks the line and the model is called ONCE', async () => {
    const { outcome, spoken, deltas, modelCalls } = await runTurn({
      complete: [{ role: "assistant", content: "Your order ships Tuesday." }],
    });
    // The whole point: one `doStream`, for the step that issued the tool call.
    // Without the stop condition the SDK's next move after a tool result is
    // another model call — the round-trip this removes.
    expect(modelCalls).toBe(1);
    expect(spoken.at(-1)).toEqual({ text: "Your order ships Tuesday.", record: true });
    expect(deltas.join("")).toBe("Your order ships Tuesday.");
    expect(deltas.join("")).not.toContain("model spoke");
    // And it reaches the model's view of the conversation, or the NEXT turn
    // would not know the agent had said it.
    expect(outcome.messages.at(-1)).toEqual({
      role: "assistant",
      content: "Your order ships Tuesday.",
    });
  });

  test('`role: "system"` calls the model, with the hint attached to the result', async () => {
    const { spoken, deltas, modelCalls } = await runTurn({
      complete: [{ role: "system", content: "Confirm the ship date warmly." }],
    });
    expect(modelCalls).toBe(2);
    expect(deltas.join("")).toBe("model spoke");
    expect(spoken.map((s) => s.text).join("")).toBe("model spoke");
  });

  test("with no completion declared, nothing changes", async () => {
    const { deltas, modelCalls } = await runTurn({ start: [{ content: "One sec." }] });
    expect(modelCalls).toBe(2);
    expect(deltas.join("")).toBe("model spoke");
  });

  test("a FAILED verbatim line answers without the model too", async () => {
    const { spoken, modelCalls } = await runTurn(
      {
        complete: [{ role: "assistant", content: "All set." }],
        failed: [{ role: "assistant", content: "I couldn't reach the order system." }],
      },
      '{"error":"upstream 503"}',
    );
    expect(modelCalls).toBe(1);
    expect(spoken.at(-1)?.text).toBe("I couldn't reach the order system.");
  });
});

describe("a tool's own filler and the generic dead-air cover", () => {
  useVirtualTime();

  test("the cover STANDS DOWN while a tool is covering its own gap", () => {
    // Vapi's "idle messages are disabled during tool calls". Two sentences
    // about one silence is the failure, and the AUTHOR's line is the one to
    // keep — so the generic cover re-arms instead of speaking, exactly as it
    // does for a caller who is talking.
    const covering = { value: true };
    const spoken: string[] = [];
    createStreamPartHandler({
      onDelta: () => undefined,
      sendTtsText: (text) => spoken.push(text),
      onToolCall: () => undefined,
      emitError: () => undefined,
      toolCovering: () => covering.value,
      log: silentLogger,
      sid: "s",
    });
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 4);
    expect(spoken).toEqual([]);
    // And comes back the moment the tool stops covering: the suppression is a
    // re-arm, not a cancellation, so the caller is not left uncovered for the
    // rest of the turn.
    covering.value = false;
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 4);
    expect(spoken.join("")).toContain(DEAD_AIR_OPENING_PHRASE);
  });

  test("the start line is filler and the verbatim answer is not", async () => {
    const { spoken } = await runTurn({
      start: [{ content: "One sec." }],
      complete: [{ role: "assistant", content: "Shipped Tuesday." }],
    });
    expect(spoken).toEqual([
      { text: "One sec.", record: false },
      { text: "Shipped Tuesday.", record: true },
    ]);
  });

  test("the ladder runs during the call and stops when it settles", async () => {
    // The turn BINDS its own speech channel over whatever was there (the
    // coalescer is per-turn), so the observation point is `sendTtsText` — the
    // same funnel the model's own words take.
    const controller = createToolSpeechController({ log: silentLogger, sid: "s", random: () => 0 });
    const spoken: string[] = [];
    const llm = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" }],
        [{ type: "text", text: "done" }],
      ],
    });
    // A tool that takes 5s — long enough for the 3s rung and nothing else.
    const slowTool = sleep(5000).then(() => "{}");
    const turn = consumeLlmStream({
      llm,
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: toVercelTools(
        [schemaWith({ delayed: [{ afterMs: 3000, content: "Still checking." }] })],
        {
          executeTool: () => slowTool,
          sessionId: "s",
          messages: () => [],
          toolSpeech: controller,
        },
      ),
      toolChoice: "auto",
      temperature: undefined,
      repairToolCall: async () => null,
      maxSteps: 3,
      deadAirCoverMs: 0,
      toolSpeech: controller,
      sendTtsText: (text) => spoken.push(text),
      callbacks: { report: () => undefined },
      emitError: () => undefined,
      log: silentLogger,
      sid: "s",
      signal: new AbortController().signal,
      onDelta: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(spoken).toEqual(["Still checking."]);
    await vi.advanceTimersByTimeAsync(30_000);
    await turn;
    // The rung fired ONCE: the settle stops the ladder rather than leaving it
    // re-arming into a turn that is over.
    expect(spoken).toEqual(["Still checking.", "done"]);
  });
});
