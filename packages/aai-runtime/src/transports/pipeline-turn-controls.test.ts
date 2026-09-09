// Copyright 2026 the AAI authors. MIT license.
// The three things that can STOP a pipeline turn, and the one that can rewrite
// what it says: an input guardrail, an output guardrail, a token budget, and a
// tool the author declared unrecoverable.
//
// Every case here asserts on what the caller HEARD (the TTS fake's own text
// chunks) rather than on an internal flag. That is the whole point of the
// feature: a guardrail that fires after the sentence has been synthesized has
// not prevented anything, so a spec that reads a boolean would pass against an
// implementation that speaks first and reports afterwards.

import type { AgentSessionContext } from "@alexkroman1/aai";
import { createDetachedSlotStore } from "@alexkroman1/aai/host-internal";
import { DEFAULT_ERROR_PHRASE } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { FatalToolError } from "../tool-error-policy.ts";
import { createUsageMeter } from "../usage-meter.ts";
import {
  llmCalls,
  makeOpts,
  noopToolSchema,
  useVirtualTime,
} from "./_pipeline-transport-harness.ts";
import { createTurnGuardrails } from "./pipeline-guardrails.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

const CONTEXT: AgentSessionContext = {
  sessionId: "test-sid",
  env: {},
  slots: createDetachedSlotStore(),
};

/** Everything the TTS provider was asked to say, joined. */
function spoken(tts: { last: () => { textChunks: string[] } | undefined }): string {
  return (tts.last()?.textChunks ?? []).join("");
}

describe("PipelineTransport — an OUTPUT guardrail", () => {
  test("the blocked reply is never spoken, and the verdict is said instead", async () => {
    const blocked: string[] = [];
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({
        script: [{ type: "text", text: "Take 400 mg every four hours." }],
      }),
      guardrails: createTurnGuardrails({
        outputGuardrails: [
          (text) =>
            /\bmg\b/.test(text) ? "I can't give dosage advice. Please call your pharmacist." : true,
        ],
        context: CONTEXT,
        onError: () => undefined,
        onBlocked: (_direction, replacement) => blocked.push(replacement),
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("how much should I take");

    await vi.waitFor(() => {
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalled();
    });
    // The load-bearing assertion: not one character of the model's answer
    // reached the synthesizer.
    expect(spoken(tts)).not.toContain("400 mg");
    expect(spoken(tts)).toContain("pharmacist");
    expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: "I can't give dosage advice. Please call your pharmacist.",
    });
    expect(blocked).toEqual(["I can't give dosage advice. Please call your pharmacist."]);
    await t.stop();
  });

  test("an accepted reply is spoken whole — the hold only delays it", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({
        script: [
          { type: "text", text: "Your order " },
          { type: "text", text: "ships tomorrow." },
        ],
      }),
      guardrails: createTurnGuardrails({
        outputGuardrails: [() => true],
        context: CONTEXT,
        onError: () => undefined,
        onBlocked: () => undefined,
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("where is my order");
    await vi.waitFor(() => {
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalled();
    });
    expect(spoken(tts)).toContain("Your order ships tomorrow.");
    await t.stop();
  });

  test("a session with no guardrail speaks as it streams", async () => {
    // The property the hold must not cost every other agent: with none
    // declared, text reaches TTS before the turn has finished.
    const { opts, stt, tts } = makeOpts({
      llm: createFakeLanguageModel({
        script: [
          { type: "text", text: "one " },
          { type: "text", text: "two" },
        ],
        delayMs: 50,
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("hello");
    await vi.waitFor(() => {
      expect(spoken(tts)).toContain("one");
    });
    // Said before the second delta was scripted to arrive.
    expect(spoken(tts)).not.toContain("two");
    await t.stop();
  });
});

describe("PipelineTransport — a turn that CRASHES under the hold", () => {
  const GREETING = "Hi, you're through to the pharmacy.";

  /**
   * A guardrail seam whose OUTPUT check rejects.
   *
   * The one throw injectable into the region between the hold and the verdict,
   * and the transport must not depend on that region being throw-free:
   * `TurnGuardrails` is an interface the transport is handed, `createTurnGuardrails`
   * is only today's implementation of it, and everything else under the hold —
   * the stream drain, the history writes, the outcome — is code a future change
   * can make throw.
   */
  const throwingOutputCheck = {
    holdsSpeech: true,
    checkInput: (): Promise<string | undefined> => Promise.resolve(undefined),
    checkOutput: (): Promise<string | undefined> =>
      Promise.reject(new Error("guardrail backend unreachable")),
  };

  test("does not mute the rest of the CALL", async () => {
    // The hold is session-lifetime state, so a turn that threw between holding
    // and deciding used to leave the funnel shut with `logTurnCrash` the only
    // trace: every later recordable send — the greeting a `reset()` replays
    // among them — was buffered and never heard. Only an agent declaring
    // `outputGuardrails` builds a gate that can hold, which is why no other
    // spec here could see it.
    const { opts, stt, tts, callbacks } = makeOpts({
      sessionConfig: { systemPrompt: "s", greeting: GREETING },
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Take 400 mg." }] }),
      guardrails: throwingOutputCheck,
    });
    const t = createPipelineTransport(opts);
    await t.start();
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalledOnce();
    });

    stt.last()?.fireFinal("how much should I take");
    await vi.waitFor(() => {
      expect(llmCalls(opts).calls).toHaveLength(1);
    });
    // The crashed turn's words are unjudged, so they stay unspoken — that half
    // was never in doubt, and it is what makes the next assertion meaningful.
    await vi.advanceTimersByTimeAsync(50);
    expect(spoken(tts)).not.toContain("400 mg");

    // "New Conversation": the greeting is a recordable send made outside any
    // turn, so a gate still holding swallows the agent's own opening line.
    t.reset?.();
    await vi.waitFor(() => {
      expect(tts.last()?.textChunks.filter((c) => c === GREETING)).toHaveLength(2);
    });
    await t.stop();
  });
});

describe("PipelineTransport — an INPUT guardrail", () => {
  test("refuses before the model, so no request is made at all", async () => {
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "here is your balance" }] }),
      guardrails: createTurnGuardrails({
        inputGuardrails: [
          (text) => (/\d{3}-\d{2}-\d{4}/.test(text) ? "Please don't read that out." : true),
        ],
        context: CONTEXT,
        onError: () => undefined,
        onBlocked: () => undefined,
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("my number is 123-45-6789");
    await vi.waitFor(() => {
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalled();
    });
    expect(llmCalls(opts).calls).toHaveLength(0);
    expect(spoken(tts)).toContain("Please don't read that out.");
    await t.stop();
  });

  test("the refused utterance still reaches the conversation", async () => {
    // A conversation that silently forgets a refused turn is one the model
    // answers inconsistently on the next.
    const { opts, stt, callbacks } = makeOpts({
      guardrails: createTurnGuardrails({
        inputGuardrails: [() => "I can't help with that."],
        context: CONTEXT,
        onError: () => undefined,
        onBlocked: () => undefined,
      }),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("something forbidden");
    await vi.waitFor(() => {
      expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
        type: "user-transcript.committed",
        text: "something forbidden",
      });
    });
    await t.stop();
  });
});

describe("PipelineTransport — a token budget", () => {
  test("a completed step is recorded, so the meter moves without a limit", async () => {
    // The other half of the wiring: `onUsage` on each `onStepFinish` is the one
    // place the provider's own counts reach this process, and a budget over a
    // meter nothing feeds would never trip.
    const usage = createUsageMeter({ onUpdate: () => undefined });
    const { opts, stt, callbacks } = makeOpts({ usage });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("hello");
    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
    });
    expect(usage.snapshot().steps).toBeGreaterThan(0);
    await t.stop();
  });

  test("an exhausted session refuses the turn and reports a FATAL error", async () => {
    const usage = createUsageMeter({
      limits: { totalTokens: 100 },
      onUpdate: () => undefined,
    });
    usage.record({ inputTokens: 90, outputTokens: 30 });
    const { opts, stt, callbacks } = makeOpts({ usage });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("one more question");
    await vi.waitFor(() => {
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith(
        expect.objectContaining({ code: "internal", fatal: true }),
      );
    });
    // No request was made — the cap is checked BEFORE one, which is what makes
    // the overrun exactly one turn rather than unbounded.
    expect(llmCalls(opts).calls).toHaveLength(0);
    await t.stop();
  });
});

describe("PipelineTransport — a FATAL tool error stops the turn", () => {
  /** A two-step script: call a tool, then answer. Step 2 must never run. */
  const twoSteps = () =>
    createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" }],
        [{ type: "text", text: "I looked it up and here is the answer." }],
      ],
    });

  test("the model gets no second step, and the caller hears the recovery phrase", async () => {
    // The point of the whole mechanism. `executeToolCall` already REJECTED for
    // a fatal error before this existed; the AI SDK caught the rejection,
    // emitted a `tool-error` part the pipeline drops, and went on stepping — so
    // the model answered anyway, from a tool the author had declared broken.
    const { opts, stt, tts, callbacks } = makeOpts({
      llm: twoSteps(),
      toolSchemas: [noopToolSchema],
      executeTool: () => Promise.reject(new FatalToolError("lookup", new Error("no credential"))),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("look it up");

    await vi.waitFor(() => {
      expect(spoken(tts)).toContain(DEFAULT_ERROR_PHRASE);
    });
    // ONE request. A second entry here is the turn continuing, which is exactly
    // the behaviour this feature removes.
    expect(llmCalls(opts).calls).toHaveLength(1);
    expect(spoken(tts)).not.toContain("here is the answer");
    expect(callbacks.reported("error.reported")).toHaveBeenCalledWith(
      expect.objectContaining({ code: "tool", fatal: false }),
    );
    await t.stop();
  });

  test("the SESSION survives it — the next turn runs normally", async () => {
    // `fatal: false` above is the claim; this is the behaviour behind it. A
    // failing TURN is not a failing session, and the latch is reset per turn.
    let calls = 0;
    const { opts, stt, tts } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" }],
          [{ type: "text", text: "second turn answer" }],
        ],
      }),
      toolSchemas: [noopToolSchema],
      executeTool: () => {
        calls += 1;
        return Promise.reject(new FatalToolError("lookup", new Error("no credential")));
      },
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("look it up");
    await vi.waitFor(() => {
      expect(spoken(tts)).toContain(DEFAULT_ERROR_PHRASE);
    });

    stt.last()?.fireFinal("never mind, just say something");
    await vi.waitFor(() => {
      expect(spoken(tts)).toContain("second turn answer");
    });
    expect(calls).toBe(1);
    await t.stop();
  });

  test("an ordinary tool failure still lets the turn finish", async () => {
    // The regression this must not cause: a tool with no `onError` answers the
    // model with a serialized failure, and the reply continues from it.
    const { opts, stt, tts } = makeOpts({
      llm: twoSteps(),
      toolSchemas: [noopToolSchema],
      executeTool: () => Promise.resolve('{"error":"upstream is down"}'),
    });
    const t = createPipelineTransport(opts);
    await t.start();
    stt.last()?.fireFinal("look it up");
    await vi.waitFor(() => {
      expect(spoken(tts)).toContain("here is the answer");
    });
    expect(llmCalls(opts).calls).toHaveLength(2);
    await t.stop();
  });
});
