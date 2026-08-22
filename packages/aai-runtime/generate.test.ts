// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the host `ctx.generate` implementation — descriptor
 * resolution through the real registry (a fake LLM kind), text vs
 * structured-output dispatch, and the Zod-schema parity guard.
 */

import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FAKE_LLM_API_KEY_ENV, registerFakeProviders } from "./_pipeline-test-fakes.ts";
import { createGenerateFn } from "./generate.ts";

/**
 * Minimal one-shot model: implements `doGenerate` (what `generateText` drives)
 * structurally, recording each call's options.
 *
 * `finishReason` is the `{ unified, raw }` PAIR the current provider spec
 * reads (`currentModelResponse.finishReason.unified`), not a bare `"stop"`.
 * The bare string was silently accepted for as long as nothing in the path
 * looked at it — and structured output does: `generateText` parses `output`
 * only when the last step finished with `stop`, so a fake reporting the old
 * shape resolves `undefined` and the typed accessor throws
 * `NoOutputGeneratedError`, naming an empty model reply rather than a stale
 * fake. `tool-call-salvage.test.ts` already had it right.
 */
function fakeOneShotModel(reply: (opts: { prompt: unknown }) => string): LanguageModel & {
  readonly calls: readonly Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  const model = {
    specificationVersion: "v3" as const,
    provider: "fake-llm",
    modelId: "fake-llm-1",
    supportedUrls: {} as Record<string, RegExp[]>,
    calls,
    async doGenerate(opts: Record<string, unknown>) {
      calls.push(opts);
      return {
        content: [{ type: "text", text: reply(opts as { prompt: unknown }) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream(): Promise<never> {
      throw new Error("fake one-shot LLM: doStream not implemented");
    },
  };
  return model as unknown as LanguageModel & {
    readonly calls: readonly Record<string, unknown>[];
  };
}

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

function setup(reply: (opts: { prompt: unknown }) => string = () => "generated text") {
  const model = fakeOneShotModel(reply);
  const fakes = registerFakeProviders({ llm: model });
  unregister = fakes.unregister;
  if (!fakes.llm) throw new Error("fake llm descriptor missing");
  return { model, descriptor: fakes.llm, env: fakes.env };
}

describe("createGenerateFn", () => {
  it("generates text through the default descriptor", async () => {
    const { model, descriptor, env } = setup();
    const generate = createGenerateFn({ llm: descriptor, env });
    const result = await generate({ prompt: "hello" });
    expect(result).toEqual({ text: "generated text" });
    expect(model.calls).toHaveLength(1);
  });

  it("returns a parsed object for JSON Schema calls", async () => {
    const { descriptor, env } = setup(() => JSON.stringify({ n: 42 }));
    const generate = createGenerateFn({ llm: descriptor, env });
    const jsonSchemaObj = z.toJSONSchema(z.object({ n: z.number() })) as Record<string, unknown>;
    const result = await generate({ prompt: "count", schema: jsonSchemaObj });
    expect(result.object).toEqual({ n: 42 });
    expect(result.text).toBe(JSON.stringify({ n: 42 }));
  });

  it("accepts a Zod schema directly, converting it before the call", async () => {
    const { descriptor, env } = setup(() => JSON.stringify({ n: 7 }));
    const generate = createGenerateFn({ llm: descriptor, env });
    const result = await generate({ prompt: "count", schema: z.object({ n: z.number() }) });
    expect(result.object).toEqual({ n: 7 });
  });

  it("rejects a pre-v4 Zod-like schema (safeParse, no Standard Schema)", async () => {
    const { descriptor, env } = setup();
    const generate = createGenerateFn({ llm: descriptor, env });
    await expect(
      generate({
        prompt: "count",
        schema: { safeParse: () => ({ success: true }) } as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/pre-v4 Zod/);
  });

  it("a per-call llm descriptor overrides the default", async () => {
    const { descriptor, env } = setup();
    // No default configured — only the per-call descriptor makes it work.
    const generate = createGenerateFn({ env });
    const result = await generate({ prompt: "hello", llm: descriptor });
    expect(result.text).toBe("generated text");
  });

  it("throws a descriptive error when no LLM is configured", async () => {
    const generate = createGenerateFn({ env: {} });
    await expect(generate({ prompt: "hello" })).rejects.toThrow(/no LLM configured/);
  });

  it("resolves credentials from the supplied env only", async () => {
    const { descriptor } = setup();
    const generate = createGenerateFn({ llm: descriptor, env: {} });
    await expect(generate({ prompt: "hello" })).rejects.toThrow(FAKE_LLM_API_KEY_ENV);
  });

  it("passes temperature, maxOutputTokens, and the abort signal through", async () => {
    const { model, descriptor, env } = setup();
    const generate = createGenerateFn({ llm: descriptor, env });
    const controller = new AbortController();
    await generate(
      { prompt: "hello", temperature: 0.2, maxOutputTokens: 64 },
      { signal: controller.signal },
    );
    expect(model.calls[0]).toMatchObject({ temperature: 0.2, maxOutputTokens: 64 });
    expect(model.calls[0]?.abortSignal).toBeDefined();
  });
});
