// Copyright 2026 the AAI authors. MIT license.
/**
 * End-to-end regression test for OpenAI Responses history replay.
 *
 * The OpenAI Responses API pairs every assistant `message` / `function_call`
 * item with the `reasoning` item (`rs_...`) that produced it. If a follow-up
 * request replays the message item but drops its reasoning item, the API
 * rejects the whole request with a hard 400:
 *
 *   Item 'msg_...' of type 'message' was provided without its required
 *   'reasoning' item: 'rs_...'.
 *
 * This regressed twice through different layers (#640 stripped reasoning in
 * pipeline-history; #641 fixed metadata loss in the smooth-stream transform),
 * so this spec pins the WHOLE chain: a real `createPipelineTransport` turn
 * (streamText → smoothTextStream → step response messages → pipeline-history)
 * followed by a second turn against the real `@ai-sdk/openai` Responses model
 * with a stubbed `fetch`, asserting the actual request `input` still carries
 * the reasoning items.
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import { makeOpts, noopToolSchema } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

// ─── OpenAI-Responses-shaped fake for turn 1 ─────────────────────────────────

/** providerMetadata carried by reasoning parts from the Responses provider. */
function reasoningMeta(itemId: string): Record<string, Record<string, unknown>> {
  return { openai: { itemId, reasoningEncryptedContent: null } };
}

/**
 * Loose local shape of a `LanguageModelV3StreamPart` (mirrors the approach in
 * `_pipeline-test-fakes.ts` — no direct `@ai-sdk/provider` dependency).
 */
type StreamPart = Record<string, unknown> & { type: string };

/** Turn 1, step 1: reasoning item + function call (no spoken text). */
const TOOL_CALL_STEP: StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "reasoning-start", id: "rs_1:0", providerMetadata: reasoningMeta("rs_1") },
  { type: "reasoning-end", id: "rs_1:0", providerMetadata: reasoningMeta("rs_1") },
  {
    type: "tool-call",
    toolCallId: "call_1",
    toolName: "lookup",
    input: "{}",
    providerMetadata: { openai: { itemId: "fc_1" } },
  },
  {
    type: "finish",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "tool-calls",
  },
];

/** Turn 1, step 2: reasoning item + the spoken answer message. */
const ANSWER_STEP: StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "reasoning-start", id: "rs_2:0", providerMetadata: reasoningMeta("rs_2") },
  { type: "reasoning-end", id: "rs_2:0", providerMetadata: reasoningMeta("rs_2") },
  { type: "text-start", id: "msg_2", providerMetadata: { openai: { itemId: "msg_2" } } },
  { type: "text-delta", id: "msg_2", delta: "Found it." },
  { type: "text-end", id: "msg_2", providerMetadata: { openai: { itemId: "msg_2" } } },
  {
    type: "finish",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  },
];

function toStream(parts: StreamPart[]): ReadableStream<StreamPart> {
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/** Minimal structural view of a v3 model — enough to delegate `doStream`. */
type V3Model = {
  doStream(opts: Record<string, unknown>): PromiseLike<{ stream: ReadableStream<unknown> }>;
};

/**
 * A model whose first turn replays the scripted OpenAI-shaped steps and whose
 * subsequent calls delegate to the REAL `@ai-sdk/openai` Responses model, so
 * the replayed history goes through the provider's actual input conversion.
 */
function createHybridModel(realModel: V3Model): LanguageModel {
  const scriptedSteps = [TOOL_CALL_STEP, ANSWER_STEP];
  let call = 0;
  const model = {
    specificationVersion: "v3" as const,
    provider: "fake-openai",
    modelId: "gpt-5.5",
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate(): Promise<never> {
      throw new Error("not implemented");
    },
    async doStream(opts: Record<string, unknown>): Promise<{ stream: ReadableStream<unknown> }> {
      const scripted = scriptedSteps[call];
      call++;
      if (scripted) return { stream: toStream(scripted) };
      return realModel.doStream(opts);
    },
  };
  return model as unknown as LanguageModel;
}

// ─── Spec ─────────────────────────────────────────────────────────────────────

describe("OpenAI Responses history replay", () => {
  test("second-turn request input keeps the reasoning items paired with their message/tool-call items", async () => {
    // Real Responses model with a stubbed fetch that captures each request
    // body. The 400 reply stops the turn — only the captured input matters.
    const requests: { input?: Record<string, unknown>[] }[] = [];
    const openai = createOpenAI({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as (typeof requests)[number]);
        return new Response(JSON.stringify({ error: { message: "captured" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const realModel = openai("gpt-5.5") as unknown as V3Model;

    const { opts, stt, callbacks } = makeOpts({
      llm: createHybridModel(realModel),
      toolSchemas: [noopToolSchema],
      executeTool: async () => "result-data",
    });
    const t = createPipelineTransport(opts);
    await t.start();

    // Turn 1: scripted reasoning + tool call + answer, persisted into history.
    stt.last()?.fireFinal("first question");
    await vi.waitFor(() => {
      expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
    });

    // Turn 2: history replays through the real provider's input conversion.
    stt.last()?.fireFinal("second question");
    await vi.waitFor(() => {
      expect(requests.length).toBeGreaterThan(0);
    });
    await t.stop();

    const input = requests[0]?.input ?? [];
    const referencedIds = input
      .filter((item) => item.type === "item_reference")
      .map((item) => item.id);

    // The regression: msg_2 replayed without rs_2 → the API 400s with
    // "Item 'msg_2' ... provided without its required 'reasoning' item: 'rs_2'".
    expect(referencedIds).toContain("rs_2");
    expect(referencedIds).toContain("msg_2");
    // Reasoning must precede the message item it produced.
    expect(referencedIds.indexOf("rs_2")).toBeLessThan(referencedIds.indexOf("msg_2"));

    // Same pairing for the tool-call step, plus the cross-turn tool context.
    expect(referencedIds).toContain("rs_1");
    expect(input).toContainEqual(
      expect.objectContaining({ type: "function_call", call_id: "call_1" }),
    );
    expect(input).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
    );
  });
});
