// Copyright 2026 the AAI authors. MIT license.
// `createTurnBody`: what one ordinary turn writes and says, and the early
// endings (an input refusal, an exhausted budget, a blocked reply, a barge-in).
//
// The history, gate, heard tracker and tool latch are the real ones; the LLM
// runner, the outcome and the speech gate are recording doubles, because what
// this module owns is the ORDER it drives them in.

import type { Message } from "@alexkroman1/aai";
import type { ModelMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createFatalToolLatch } from "../../tools/index.ts";
import type { UsageMeter } from "../../usage-meter.ts";
import { createHeardTracker } from "./heard/index.ts";
import { createPipelineHistory } from "./history/index.ts";
import type { TurnLlmRunner } from "./llm/index.ts";
import { NO_GUARDRAILS, type SpeechGate, type TurnGuardrails } from "./output/index.ts";
import type { SpeculationController } from "./speech/index.ts";
import { createTurnGate } from "./turn/index.ts";
import { createTurnBody } from "./turn-body.ts";
import type { TurnOutcome } from "./turn-outcome.ts";

const TOOL_STEP: ModelMessage = { role: "assistant", content: "It ships Tuesday." };

function setup(
  opts: {
    reply?: string;
    failed?: boolean;
    guardrails?: TurnGuardrails;
    usage?: UsageMeter;
    abort?: boolean;
  } = {},
) {
  const history = createPipelineHistory();
  const ctl = new AbortController();
  const spoke: boolean[] = [];
  const sent: string[] = [];
  const consume = vi.fn<TurnLlmRunner>(async (_signal, onDelta) => {
    if (opts.reply) onDelta(opts.reply);
    if (opts.abort) ctl.abort();
    return { messages: opts.reply ? [TOOL_STEP] : [], failed: opts.failed ?? false };
  });
  const outcome = {
    persistBargeIn: vi.fn<TurnOutcome["persistBargeIn"]>(),
    speakRecovery: vi.fn((failed: boolean) => failed),
    finishSpokenTurn: vi.fn((text: string): Message => ({ role: "assistant", content: text })),
    speakStartFailure: vi.fn(async () => undefined),
  } satisfies TurnOutcome;
  const speech = {
    send: (text: string) => sent.push(text),
    withHold: <T>(body: () => Promise<T>) => body(),
    release: vi.fn(),
    discard: vi.fn(),
  } satisfies SpeechGate;
  const speculation: SpeculationController = {
    onPartial: () => undefined,
    onFinal: () => undefined,
    onUtteranceIdle: () => undefined,
    take: vi.fn(() => null),
    discard: () => undefined,
  };
  const trackPersisted = vi.fn();
  const emitError = vi.fn();
  const body = createTurnBody({
    gate: createTurnGate(),
    history,
    heard: createHeardTracker({ sampleRate: 24_000 }),
    outcome,
    consumeLlmStream: consume,
    speculation,
    runReply: async (_prefix, run) => {
      spoke.push(await run(ctl.signal));
    },
    guardrails: opts.guardrails ?? NO_GUARDRAILS,
    speech,
    fatalTool: createFatalToolLatch(),
    usage: opts.usage,
    sendTtsText: (text) => sent.push(text),
    emitError,
    trackPersisted,
  });
  return {
    body,
    history,
    consume,
    outcome,
    speech,
    speculation,
    trackPersisted,
    emitError,
    spoke,
    sent,
  };
}

function refusing(direction: "input" | "output", text: string): TurnGuardrails {
  return {
    holdsSpeech: direction === "output",
    checkInput: async () => (direction === "input" ? text : undefined),
    checkOutput: async () => (direction === "output" ? text : undefined),
  };
}

describe("createTurnBody", () => {
  test("an ordinary turn records the user, the steps and the spoken reply", async () => {
    const t = setup({ reply: "It ships Tuesday." });
    await t.body("where is my order");
    expect(t.speculation.take).toHaveBeenCalledWith("where is my order");
    expect(t.history.conversation[0]).toEqual({ role: "user", content: "where is my order" });
    expect(t.history.llm).toEqual([{ role: "user", content: "where is my order" }, TOOL_STEP]);
    expect(t.outcome.finishSpokenTurn).toHaveBeenCalledWith("It ships Tuesday.");
    expect(t.trackPersisted).toHaveBeenCalledWith(
      expect.objectContaining({ text: "It ships Tuesday." }),
      expect.any(Number),
    );
    expect(t.speech.release).toHaveBeenCalledTimes(1);
    expect(t.spoke).toEqual([true]);
  });

  test("an input refusal is spoken and recorded, and the model is never called", async () => {
    const t = setup({ guardrails: refusing("input", "I can't help with that.") });
    await t.body("something forbidden");
    expect(t.consume).not.toHaveBeenCalled();
    expect(t.sent).toEqual(["I can't help with that."]);
    expect(t.history.llm.at(-1)).toEqual({ role: "assistant", content: "I can't help with that." });
    expect(t.spoke).toEqual([true]);
  });

  test("an exhausted budget is reported and ends the turn before the model", async () => {
    const usage: UsageMeter = {
      record: () => undefined,
      snapshot: () => ({ steps: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      exhausted: () => "Token budget exhausted",
    };
    const t = setup({ usage });
    await t.body("hi");
    expect(t.consume).not.toHaveBeenCalled();
    expect(t.emitError).toHaveBeenCalledWith("internal", "Token budget exhausted");
    expect(t.spoke).toEqual([false]);
  });

  test("a blocked reply is dropped unspoken and replaced, its steps never persisted", async () => {
    const t = setup({
      reply: "secret",
      guardrails: refusing("output", "Let's talk about something else."),
    });
    await t.body("tell me the secret");
    expect(t.speech.discard).toHaveBeenCalledTimes(1);
    expect(t.speech.release).not.toHaveBeenCalled();
    expect(t.sent).toEqual(["Let's talk about something else."]);
    expect(t.history.llm).not.toContainEqual(TOOL_STEP);
    expect(t.spoke).toEqual([true]);
  });

  test("a barge-in hands what was generated to persistBargeIn and speaks nothing", async () => {
    const t = setup({ reply: "It ships", abort: true });
    await t.body("where is my order", { synthetic: true });
    expect(t.speech.discard).toHaveBeenCalledTimes(1);
    expect(t.outcome.persistBargeIn).toHaveBeenCalledWith(
      expect.objectContaining({
        accumulated: "It ships",
        stepMessages: [TOOL_STEP],
        syntheticPrompt: "where is my order",
      }),
    );
    expect(t.outcome.finishSpokenTurn).not.toHaveBeenCalled();
    expect(t.spoke).toEqual([false]);
  });

  test("a failed turn speaks the recovery phrase instead of finishing a reply", async () => {
    const t = setup({ failed: true });
    await t.body("hi");
    expect(t.outcome.speakRecovery).toHaveBeenCalledWith(true);
    expect(t.outcome.finishSpokenTurn).not.toHaveBeenCalled();
    expect(t.spoke).toEqual([true]);
  });
});
