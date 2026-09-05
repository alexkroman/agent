// Copyright 2026 the AAI authors. MIT license.
/**
 * The deferred model must be indistinguishable from the eager one in the three
 * members a caller can read WITHOUT awaiting — `specificationVersion`,
 * `provider` and `modelId`. Those are hand-written constants in
 * `_llm-registry.ts` (a not-yet-loaded package cannot be asked), so this file
 * is what stops them drifting: it builds each kind's real vendor model and
 * compares. A vendor renaming its provider id — `openai.responses` becoming
 * `openai.v2`, say — fails here rather than quietly changing what lands in
 * every trace.
 */

import {
  ANTHROPIC_KIND,
  ASSEMBLYAI_LLM_KIND,
  GATEWAY_KIND,
  GOOGLE_KIND,
  GROQ_KIND,
  MISTRAL_KIND,
  OPENAI_KIND,
  OPENROUTER_KIND,
  XAI_KIND,
} from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { describe, expect, it } from "vitest";
import { type DeferredModel, lazyModel } from "./_lazy-model.ts";
import { LLM_REGISTRY } from "./_llm-registry.ts";

/** How each kind's vendor model is built eagerly — the twin under test. */
const EAGER: Record<string, (apiKey: string, modelId: string) => Promise<unknown>> = {
  [ANTHROPIC_KIND]: async (apiKey, modelId) =>
    (await import("@ai-sdk/anthropic")).createAnthropic({
      apiKey,
      baseURL: "https://api.anthropic.com/v1",
    })(modelId),
  [OPENAI_KIND]: async (apiKey, modelId) =>
    (await import("@ai-sdk/openai")).createOpenAI({ apiKey })(modelId),
  [GOOGLE_KIND]: async (apiKey, modelId) =>
    (await import("@ai-sdk/google")).createGoogleGenerativeAI({ apiKey })(modelId),
  [MISTRAL_KIND]: async (apiKey, modelId) =>
    (await import("@ai-sdk/mistral")).createMistral({ apiKey })(modelId),
  [XAI_KIND]: async (apiKey, modelId) =>
    (await import("@ai-sdk/xai")).createXai({ apiKey })(modelId),
  [GROQ_KIND]: async (apiKey, modelId) =>
    (await import("@ai-sdk/groq")).createGroq({ apiKey })(modelId),
  [OPENROUTER_KIND]: async (apiKey, modelId) =>
    (await import("@ai-sdk/openai"))
      .createOpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1", name: "openrouter" })
      .chat(modelId),
  [ASSEMBLYAI_LLM_KIND]: async (apiKey, modelId) =>
    (await import("@ai-sdk/openai"))
      .createOpenAI({
        apiKey,
        baseURL: "https://llm-gateway.assemblyai.com/v1",
        name: "assemblyai",
      })
      .chat(modelId),
};

function descriptor(kind: string, model: string): LlmProvider {
  return { kind, options: { model } } as LlmProvider;
}

describe("the deferred model matches its eager twin", () => {
  // GATEWAY_KIND is deliberately absent from EAGER: `createGateway` ships
  // inside `ai`, so that entry is not deferred at all and has no twin to
  // compare against. Asserted below rather than left implicit.
  it.each(Object.keys(EAGER))("%s reports the same identity before loading", async (kind) => {
    const deferred = LLM_REGISTRY[kind]?.create("test-key", descriptor(kind, "some-model-id"));
    const eager = (await EAGER[kind]?.("test-key", "some-model-id")) as {
      specificationVersion: string;
      provider: string;
      modelId: string;
    };
    expect(deferred).toMatchObject({
      specificationVersion: eager.specificationVersion,
      provider: eager.provider,
      modelId: eager.modelId,
    });
  });

  it("covers every deferred kind in the registry", () => {
    // The gateway entry is the one built eagerly; every other kind must have a
    // twin above, so adding a provider without one fails here.
    expect(Object.keys(EAGER).sort()).toEqual(
      Object.keys(LLM_REGISTRY)
        .filter((k) => k !== GATEWAY_KIND)
        .sort(),
    );
  });
});

/**
 * A real, minimal {@link DeferredModel} — the typed seam the `lazyModel` specs
 * are written against.
 *
 * Every field below is a legal value of its own type, so the fake needs no
 * cast: `content`/`warnings` are empty arrays, `usage` carries the two token
 * counts the spec requires, and the stream is an empty `ReadableStream`. The
 * alternative — `as never` at each of six assertion sites — is what the escape
 * hatch ratchet exists to refuse, and it would also stop reporting the moment
 * a field is ADDED to the provider spec.
 */
function stubModel(): DeferredModel & {
  calls: { generate: number; stream: number };
} {
  const calls = { generate: 0, stream: 0 };
  const model: DeferredModel = {
    specificationVersion: "v4",
    provider: "stub.provider",
    modelId: "stub-model",
    supportedUrls: {},
    async doGenerate() {
      calls.generate += 1;
      return {
        content: [],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
    async doStream() {
      calls.stream += 1;
      return { stream: new ReadableStream({ start: (c) => c.close() }) };
    },
  };
  return { ...model, calls };
}

/** The smallest legal call — a one-message prompt, every other option absent. */
function callOptions(): Parameters<DeferredModel["doGenerate"]>[0] {
  return { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
}

describe("lazyModel", () => {
  it("does not build the model until a method is called", () => {
    let built = 0;
    lazyModel("p", "m", async () => {
      built += 1;
      return stubModel();
    });
    expect(built).toBe(0);
  });

  it("builds once across concurrent first calls", async () => {
    const inner = stubModel();
    let built = 0;
    const m = lazyModel("p", "m", async () => {
      built += 1;
      return inner;
    });
    await Promise.all([m.doGenerate(callOptions()), m.doStream(callOptions()), m.supportedUrls]);
    expect(built).toBe(1);
    expect(inner.calls).toEqual({ generate: 1, stream: 1 });
  });

  it("forwards to the built model on every later call", async () => {
    const inner = stubModel();
    const m = lazyModel("p", "m", async () => inner);
    await m.doGenerate(callOptions());
    await m.doGenerate(callOptions());
    expect(inner.calls.generate).toBe(2);
  });

  it("reports identity without awaiting anything", () => {
    const m = lazyModel("openai.responses", "gpt-x", async () => {
      expect.fail("must not load to read identity");
    });
    expect(m.specificationVersion).toBe("v4");
    expect(m.provider).toBe("openai.responses");
    expect(m.modelId).toBe("gpt-x");
  });
});
