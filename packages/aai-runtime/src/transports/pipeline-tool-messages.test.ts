// Copyright 2026 the AAI authors. MIT license.
// `ToolDef.messages` through a real turn: `consumeLlmStream` over a scripted
// model, the real `toVercelTools` execute path and the real controller.
//
// The two claims that cannot be made one layer down. "`role: "assistant"`
// means the model is NOT CALLED" is a property of the step loop, so the
// assertion has to count the model's `doStream` calls; and "a tool covering
// its own gap silences the generic cover" is a property of two timers in
// different modules agreeing.

import { dialog, sessionSlot, type ToolDef, type ToolMessages } from "@alexkroman1/aai";
import { DEAD_AIR_OPENING_PHRASE, DEFAULT_DEAD_AIR_COVER_MS } from "@alexkroman1/aai/host-internal";
import { sleep } from "@alexkroman1/aai/internal";
import { agentToolsToSchemas, type ToolSchema, toolset } from "@alexkroman1/aai/manifest";
import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { silentLogger } from "../_test-utils.ts";
import { toVercelTools } from "../to-vercel-tools.ts";
import { executeToolCall } from "../tool-executor.ts";
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
  return await runTurnWith(schemaWith(messages), async () => result);
}

/**
 * {@link runTurn} over a caller's own declaration and executor — so a spec can
 * hand it the schema `agentToolsToSchemas` derives from a REAL tool and run
 * that tool's `execute`, rather than a hand-written schema and a canned result.
 */
async function runTurnWith(schema: ToolSchema, executeTool: () => Promise<string>) {
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
    tools: toVercelTools([schema], {
      executeTool,
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

describe("slot and dialog tools speak through the same path as `tool()`", () => {
  // `SlotToolDef` and `DialogToolDef` used to restate `ToolDef` field by field,
  // and neither restated `messages` — so the two builders a stateful agent
  // writes most could not declare tool-call speech. Both are built FROM
  // `ToolDef` now; these run the REAL built tool through a real turn, so the
  // claim is the whole path: the def, the builder's spread, the wire
  // declaration, the executor, and the line.
  type Cart = { items: string[] };
  const cartSlot = sessionSlot("cart", (): Cart => ({ items: [] }));

  async function runBuilt(name: string, def: ToolDef) {
    const [schema] = agentToolsToSchemas([toolset("files", { [name]: def })]);
    if (schema === undefined) throw new Error("no schema");
    return await runTurnWith({ ...schema, name: "lookup" }, () =>
      executeToolCall(
        name,
        {},
        { toolset: toolset("files", { [name]: def }), env: {}, sessionId: "s" },
      ),
    );
  }

  test("a slot.updateTool's verbatim completion is spoken, and the model is not called again", async () => {
    const add = cartSlot.updateTool({
      description: "Add an item",
      execute: (_args, cart) => {
        cart.items.push("apple");
        return { count: cart.items.length };
      },
      messages: { complete: [{ role: "assistant", content: "Added it to your cart." }] },
    });
    const { spoken, modelCalls } = await runBuilt("add_item", add);
    expect(modelCalls).toBe(1);
    expect(spoken.at(-1)).toEqual({ text: "Added it to your cart.", record: true });
  });

  test("a dialog tool's REFUSAL takes the `failed` line, because a refusal is a ToolFailure", async () => {
    const flow = dialog("flow", {
      initial: "collecting",
      states: { collecting: { on: { DONE: "confirming" } }, confirming: { final: true } },
    });
    const confirm = flow.tool({
      description: "Confirm the booking",
      when: "confirming",
      execute: () => "confirmed",
      messages: {
        complete: [{ role: "assistant", content: "You're booked." }],
        failed: [{ role: "assistant", content: "We are not there yet." }],
      },
    });
    const { spoken, modelCalls } = await runBuilt("confirm", confirm);
    expect(modelCalls).toBe(1);
    expect(spoken.at(-1)?.text).toBe("We are not there yet.");
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
    // And comes back the moment the predicate clears: the handler's
    // suppression is a re-arm, not a cancellation. (The predicate the turn
    // wires in is `coveredThisTurn`, which stays true for the rest of a turn
    // whose tool covered itself — see the turn-level specs below.)
    covering.value = false;
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 4);
    expect(spoken.join("")).toContain(DEAD_AIR_OPENING_PHRASE);
  });

  /**
   * A turn where the model calls `lookup` at 2s, the tool returns at once, and
   * the answer starts at ~4s — the shape of a home speaker's weather turn,
   * where the generic cover's tool window (1.2s) fired AFTER the call had
   * returned and played straight into the reply as its preamble.
   */
  async function coveredTurn(messages: ToolMessages | undefined) {
    const controller = createToolSpeechController({ log: silentLogger, sid: "s", random: () => 0 });
    const spoken: string[] = [];
    const llm = createFakeLanguageModel({
      delayMs: 2000,
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" }],
        [{ type: "text", text: "It's 59 degrees." }],
      ],
    });
    const schema =
      messages === undefined ? { ...schemaWith({}), messages: undefined } : schemaWith(messages);
    const turn = consumeLlmStream({
      llm,
      systemPrompt: "s",
      messages: [{ role: "user", content: "what's the weather" }],
      tools: toVercelTools([schema], {
        executeTool: async () => "{}",
        sessionId: "s",
        messages: () => [],
        toolSpeech: controller,
      }),
      toolChoice: "auto",
      temperature: undefined,
      repairToolCall: async () => null,
      maxSteps: 3,
      deadAirCoverMs: DEFAULT_DEAD_AIR_COVER_MS,
      toolSpeech: controller,
      sendTtsText: (text) => spoken.push(text),
      callbacks: { report: () => undefined },
      emitError: () => undefined,
      log: silentLogger,
      sid: "s",
      signal: new AbortController().signal,
      onDelta: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await turn;
    return spoken;
  }

  test("a tool that covers itself keeps the generic phrase out of the whole turn", async () => {
    // The call returned long before its 3s rung, so nothing covered the gap
    // while the model phrased the answer — and nothing should: that gap is a
    // beat, and filler there is heard as the answer's first words.
    const spoken = await coveredTurn({ delayed: [{ afterMs: 3000, content: "Still checking." }] });
    expect(spoken.join("")).toBe("It's 59 degrees.");
  });

  test("a tool with no cover of its own still gets the generic one", async () => {
    // The control: the stand-down is keyed on the TOOL declaring cover, so an
    // agent whose tools declare none keeps exactly the behaviour it had.
    const spoken = await coveredTurn(undefined);
    expect(spoken[0]).toBe(DEAD_AIR_OPENING_PHRASE);
  });

  test("the start line is filler and the verbatim answer is not", async () => {
    const { spoken } = await runTurn({
      start: [{ content: "One sec." }],
      complete: [{ role: "assistant", content: "Shipped Tuesday." }],
    });
    // Separated, as the dead-air cover's lines always were: both now go
    // through `speakInReply`, where they used to fuse ("sec.Shipped").
    expect(spoken).toEqual([
      { text: "One sec.", record: false },
      { text: " Shipped Tuesday.", record: true },
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
    // re-arming into a turn that is over. And the model's next words are a new
    // segment, not fused onto the rung ("checking.done").
    expect(spoken).toEqual(["Still checking.", " done"]);
  });
});
