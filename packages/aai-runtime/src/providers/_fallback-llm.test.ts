// Copyright 2026 the AAI authors. MIT license.
/**
 * The LLM half of `fallback([...])`: a `LanguageModel` over fake members,
 * driven both directly and through the AI SDK's own `streamText`, so the
 * stream a consumer reads after a switch is proven coherent.
 */

import { type LanguageModel, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { ProviderFailover } from "./_failover.ts";
import { fallbackLanguageModel, withFailoverListener } from "./_fallback-llm.ts";

type Mock = InstanceType<typeof MockLanguageModelV4>;
type StreamPart =
  Awaited<ReturnType<Mock["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const FINISH = { unified: "stop", raw: "stop" } as const;

function streamOf(parts: readonly StreamPart[], rejectWith?: unknown): ReadableStream<StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      if (rejectWith === undefined) controller.close();
      else controller.error(rejectWith);
    },
  });
}

function textParts(text: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: USAGE, finishReason: FINISH },
  ];
}

function streaming(provider: string, stream: () => ReadableStream<StreamPart>): Mock {
  return new MockLanguageModelV4({
    provider,
    modelId: `${provider}-model`,
    doStream: async () => ({ stream: stream() }),
  });
}

function throwing(provider: string, error: Error): Mock {
  return new MockLanguageModelV4({
    provider,
    modelId: `${provider}-model`,
    doStream: async () => {
      throw error;
    },
    doGenerate: async () => {
      throw error;
    },
  });
}

/** Narrow to the v4 object every member here is, so a spec can call it directly. */
function v4(model: LanguageModel): Extract<LanguageModel, { specificationVersion: "v4" }> {
  if (typeof model === "string" || model.specificationVersion !== "v4") {
    throw new Error("expected a v4 model object");
  }
  return model;
}

/** The fallback, bound to a recording listener — what the pipeline transport makes per session. */
function bound(members: { model: Mock; kind: string }[]) {
  const failovers: ProviderFailover[] = [];
  const model = v4(withFailoverListener(fallbackLanguageModel(members), (f) => failovers.push(f)));
  return { model, failovers };
}

async function textOf(model: ReturnType<typeof bound>["model"]): Promise<string> {
  const result = streamText({ model, prompt: "hi", maxRetries: 0 });
  return result.text;
}

describe("LLM fallback", () => {
  test("a doStream that throws moves to the next member, through streamText", async () => {
    const { model, failovers } = bound([
      { model: throwing("primary", new Error("503 overloaded")), kind: "assemblyai" },
      {
        model: streaming("secondary", () => streamOf(textParts("from secondary"))),
        kind: "anthropic",
      },
    ]);
    expect(await textOf(model)).toBe("from secondary");
    expect(failovers).toEqual([
      { stage: "llm", from: "assemblyai", to: "anthropic", reason: "503 overloaded" },
    ]);
  });

  test("an error part BEFORE any content discards the member — its prefix included", async () => {
    const secondary = streaming("secondary", () => streamOf(textParts("ok")));
    const { model, failovers } = bound([
      {
        model: streaming("primary", () =>
          streamOf([
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "r1" },
            { type: "error", error: new Error("upstream reset") },
          ]),
        ),
        kind: "a",
      },
      { model: secondary, kind: "b" },
    ]);
    expect(await textOf(model)).toBe("ok");
    expect(failovers.map((f) => f.reason)).toEqual(["upstream reset"]);
    expect(secondary.doStreamCalls).toHaveLength(1);
  });

  test("a stream that REJECTS before content fails over too", async () => {
    const { model, failovers } = bound([
      { model: streaming("primary", () => streamOf([], new Error("socket hang up"))), kind: "a" },
      { model: streaming("secondary", () => streamOf(textParts("ok"))), kind: "b" },
    ]);
    expect(await textOf(model)).toBe("ok");
    expect(failovers).toHaveLength(1);
  });

  test("an error AFTER content is the turn's: no switch, the secondary is never called", async () => {
    const secondary = streaming("secondary", () => streamOf(textParts("never")));
    const { model, failovers } = bound([
      {
        model: streaming("primary", () =>
          streamOf([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Half an ans" },
            { type: "error", error: new Error("cut off") },
          ]),
        ),
        kind: "a",
      },
      { model: secondary, kind: "b" },
    ]);
    const { stream } = await model.doStream({ prompt: [] });
    const types: string[] = [];
    for await (const part of stream) types.push(part.type);
    expect(types).toEqual(["stream-start", "text-start", "text-delta", "error"]);
    expect(failovers).toEqual([]);
    expect(secondary.doStreamCalls).toHaveLength(0);
  });

  test("when every member fails, the LAST error is thrown unchanged", async () => {
    const last = new Error("second down");
    const { model, failovers } = bound([
      { model: throwing("p", new Error("first down")), kind: "a" },
      { model: throwing("s", last), kind: "b" },
    ]);
    await expect(model.doStream({ prompt: [] })).rejects.toBe(last);
    await expect(model.doGenerate({ prompt: [] })).rejects.toBe(last);
    expect(failovers).toHaveLength(2);
  });

  test("never fails over on an abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const secondary = streaming("secondary", () => streamOf(textParts("no")));
    const { model, failovers } = bound([
      { model: throwing("p", new Error("aborted")), kind: "a" },
      { model: secondary, kind: "b" },
    ]);
    await expect(model.doStream({ prompt: [], abortSignal: controller.signal })).rejects.toThrow(
      "aborted",
    );
    expect(failovers).toEqual([]);
    expect(secondary.doStreamCalls).toHaveLength(0);
  });

  test("doGenerate fails over the same way", async () => {
    const secondary = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: "generated" }],
        finishReason: FINISH,
        usage: USAGE,
        warnings: [],
      },
    });
    const { model, failovers } = bound([
      { model: throwing("p", new Error("401")), kind: "a" },
      { model: secondary, kind: "b" },
    ]);
    const result = await model.doGenerate({ prompt: [] });
    expect(result.content).toEqual([{ type: "text", text: "generated" }]);
    expect(failovers).toHaveLength(1);
  });

  test("decides per REQUEST: the next call tries the primary again", async () => {
    let primaryCalls = 0;
    const primary = new MockLanguageModelV4({
      doStream: async () => {
        primaryCalls++;
        throw new Error("down");
      },
    });
    const { model } = bound([
      { model: primary, kind: "a" },
      { model: streaming("s", () => streamOf(textParts("ok"))), kind: "b" },
    ]);
    await textOf(model);
    await textOf(model);
    expect(primaryCalls).toBe(2);
  });

  test("answers the primary's identity, and binds without mutating the shared model", () => {
    const shared = fallbackLanguageModel([
      { model: streaming("primary", () => streamOf([])), kind: "a" },
      { model: streaming("secondary", () => streamOf([])), kind: "b" },
    ]);
    const perSession = withFailoverListener(shared, () => undefined);
    expect(perSession).not.toBe(shared);
    expect(typeof perSession === "string" ? "" : perSession.modelId).toBe("primary-model");
    const plain = streaming("plain", () => streamOf([]));
    expect(withFailoverListener(plain, () => undefined)).toBe(plain);
  });
});
