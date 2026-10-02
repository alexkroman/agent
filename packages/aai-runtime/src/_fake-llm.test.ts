// Copyright 2026 the AAI authors. MIT license.
/**
 * The scripted fake models, driven through the real `ai` entry points they
 * stand in for — so what is pinned is that `generateText` and `streamText`
 * READ what the fakes report (the finish-reason pair and the nested usage were
 * both once silently `undefined` at the reader).
 */

import { generateText, streamText } from "ai";
import { describe, expect, test } from "vitest";
import { createFakeLanguageModel, createScriptedOneShotModel } from "./_fake-llm.ts";

describe("createFakeLanguageModel", () => {
  test("streams the script's text and finishes with `stop`", async () => {
    const model = createFakeLanguageModel({
      script: [
        { type: "text", text: "Hello " },
        { type: "text", text: "there" },
      ],
    });
    const result = streamText({ model, prompt: "hi" });
    expect(await result.text).toBe("Hello there");
    expect(await result.finishReason).toBe("stop");
    expect(model.calls).toHaveLength(1);
  });

  test("a step that calls a tool finishes with `tool-calls`, unless the script says otherwise", async () => {
    const call = { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" } as const;
    const derived = streamText({ model: createFakeLanguageModel({ script: [call] }), prompt: "x" });
    expect(await derived.finishReason).toBe("tool-calls");

    const overridden = streamText({
      model: createFakeLanguageModel({
        script: [call, { type: "finish-reason", reason: "length" }],
      }),
      prompt: "x",
    });
    expect(await overridden.finishReason).toBe("length");
  });

  test("answers `generateText` from the same script", async () => {
    const model = createFakeLanguageModel({ script: [{ type: "text", text: "graded: yes" }] });
    const result = await generateText({ model, prompt: "grade it" });
    expect(result.text).toBe("graded: yes");
    expect(result.finishReason).toBe("stop");
  });

  test("consumes one step per call, then answers empty — or repeats the last with repeatLast", async () => {
    const steps = [
      [{ type: "text", text: "one" } as const],
      [{ type: "text", text: "two" } as const],
    ];
    const plain = createFakeLanguageModel({ steps });
    const said: string[] = [];
    for (let i = 0; i < 3; i++) said.push((await generateText({ model: plain, prompt: "p" })).text);
    expect(said).toEqual(["one", "two", ""]);

    const repeating = createFakeLanguageModel({ steps, repeatLast: true });
    const again: string[] = [];
    for (let i = 0; i < 3; i++)
      again.push((await generateText({ model: repeating, prompt: "p" })).text);
    expect(again).toEqual(["one", "two", "two"]);
  });

  test("an aborted stream stops before the rest of the script", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = createFakeLanguageModel({
      script: [{ type: "text", text: "never said" }],
      delayMs: 5,
    });
    const result = streamText({ model, prompt: "x", abortSignal: controller.signal });
    await expect(result.text).rejects.toThrow();
  });
});

describe("createScriptedOneShotModel", () => {
  test("answers one script entry per call, and spends tokens the SDK can read", async () => {
    const model = createScriptedOneShotModel([{ text: "first" }, { text: "second" }]);
    const first = await generateText({ model, prompt: "p" });
    expect(first.text).toBe("first");
    expect(first.usage.inputTokens).toBe(1);
    expect(first.usage.outputTokens).toBe(1);
    expect((await generateText({ model, prompt: "p" })).text).toBe("second");
  });

  test("past the end of the script it answers rather than throwing", async () => {
    const model = createScriptedOneShotModel([]);
    expect((await generateText({ model, prompt: "p" })).text).toBe("(script exhausted)");
  });

  test("a scripted call is returned as a tool call with the stated finish reason", async () => {
    const model = createScriptedOneShotModel([
      { call: { name: "lookup", input: { q: "x" }, id: "c9" }, finishReason: "length" },
    ]);
    const result = await generateText({ model, prompt: "p" });
    expect(result.finishReason).toBe("length");
    expect(result.toolCalls).toMatchObject([{ toolCallId: "c9", toolName: "lookup" }]);
  });

  test("records what it was asked, and refuses to stream", async () => {
    const model = createScriptedOneShotModel([{ text: "ok" }]);
    await generateText({ model, prompt: "p" });
    expect(model.calls).toHaveLength(1);
    const errors: unknown[] = [];
    const result = streamText({ model, prompt: "p", onError: ({ error }) => errors.push(error) });
    await expect(result.text).rejects.toThrow();
    expect(String(errors[0])).toMatch(/doStream not implemented/);
  });
});
