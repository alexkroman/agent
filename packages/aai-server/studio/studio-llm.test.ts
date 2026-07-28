// Copyright 2026 the AAI authors. MIT license.
// Studio chat LLM selection: host-env defaults, the picker's option list,
// and validation of a browser-supplied provider/model override.

import { describe, expect, test } from "vitest";
import {
  isStudioLlmConfigured,
  resolveStudioSelection,
  selectStudioLlm,
  studioLlmInfo,
  studioLlmOptions,
  studioModel,
} from "./studio-llm.ts";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

describe("LLM provider selection", () => {
  const noEnv = env({});

  test("nothing configured → null / unconfigured", () => {
    expect(selectStudioLlm(noEnv)).toBeNull();
    expect(isStudioLlmConfigured(noEnv)).toBe(false);
    expect(studioLlmInfo(noEnv)).toBeNull();
    expect(() => studioModel({}, noEnv)).toThrow(/not configured/);
  });

  test("prefers the AssemblyAI LLM Gateway when its key is present", () => {
    const both = env({ ASSEMBLYAI_API_KEY: "k", ANTHROPIC_API_KEY: "k2" });
    expect(selectStudioLlm(both)).toMatchObject({ provider: "assemblyai", model: "gpt-5.2" });
    expect(studioLlmInfo(both)).toEqual({ provider: "assemblyai", model: "gpt-5.2" });
    expect((studioModel({}, both) as { modelId: string }).modelId).toBe("gpt-5.2");
  });

  test("falls back to Anthropic when only its key is present", () => {
    const anthropicOnly = env({ ANTHROPIC_API_KEY: "k" });
    expect(selectStudioLlm(anthropicOnly)).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(isStudioLlmConfigured(anthropicOnly)).toBe(true);
  });

  test("explicit STUDIO_LLM_PROVIDER + STUDIO_LLM_MODEL win", () => {
    const explicit = env({
      STUDIO_LLM_PROVIDER: "openai",
      STUDIO_LLM_MODEL: "gpt-4.1",
      OPENAI_API_KEY: "k",
      ASSEMBLYAI_API_KEY: "ignored",
    });
    expect(selectStudioLlm(explicit)).toMatchObject({ provider: "openai", model: "gpt-4.1" });
    expect((studioModel({}, explicit) as { modelId: string }).modelId).toBe("gpt-4.1");
  });

  test("gateway EU region flows into the descriptor and defaults to Claude", () => {
    // gpt-5.2 leads the US list but OpenAI models are US-only, so the EU
    // default falls to the first Claude model.
    const eu = env({ ASSEMBLYAI_API_KEY: "k", STUDIO_LLM_REGION: "eu" });
    expect(selectStudioLlm(eu)?.descriptor).toMatchObject({
      kind: "assemblyai",
      options: { model: "claude-sonnet-4-6", region: "eu" },
    });
  });

  test("unknown provider and missing model are loud errors", () => {
    expect(() => selectStudioLlm(env({ STUDIO_LLM_PROVIDER: "nope" }))).toThrow(
      /Unknown STUDIO_LLM_PROVIDER/,
    );
    expect(() =>
      selectStudioLlm(env({ STUDIO_LLM_PROVIDER: "openai", OPENAI_API_KEY: "k" })),
    ).toThrow(/STUDIO_LLM_MODEL is required/);
    // isStudioLlmConfigured never throws — it reports unconfigured instead.
    expect(isStudioLlmConfigured(env({ STUDIO_LLM_PROVIDER: "nope" }))).toBe(false);
  });

  test("selected provider without its key is unconfigured", () => {
    const keyless = env({ STUDIO_LLM_PROVIDER: "anthropic" });
    expect(isStudioLlmConfigured(keyless)).toBe(false);
    expect(() => studioModel({}, keyless)).toThrow(/ANTHROPIC_API_KEY is not set/);
  });
});

describe("studioLlmOptions", () => {
  test("offers nothing when no key is configured", () => {
    expect(studioLlmOptions(env({}))).toEqual({ default: null, providers: [] });
  });

  test("lists only providers whose key the host holds", () => {
    const options = studioLlmOptions(env({ ANTHROPIC_API_KEY: "k" }));
    expect(options.providers.map((p) => p.provider)).toEqual(["anthropic"]);
    expect(options.default).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  test("lists both providers when both keys are present, gateway default", () => {
    const options = studioLlmOptions(env({ ASSEMBLYAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" }));
    expect(options.providers.map((p) => p.provider)).toEqual(["assemblyai", "anthropic"]);
    expect(options.default).toEqual({ provider: "assemblyai", model: "gpt-5.2" });
    const gatewayModels = options.providers[0]?.models ?? [];
    expect(gatewayModels[0]).toBe("gpt-5.2");
    expect(gatewayModels).toContain("claude-sonnet-4-6");
    expect(gatewayModels).toContain("gemini-2.5-flash");
  });

  test("the EU gateway offers no US-only models", () => {
    const options = studioLlmOptions(env({ ASSEMBLYAI_API_KEY: "k", STUDIO_LLM_REGION: "eu" }));
    const models = options.providers[0]?.models ?? [];
    expect(options.default).toEqual({ provider: "assemblyai", model: "claude-sonnet-4-6" });
    expect(models[0]).toBe("claude-sonnet-4-6");
    expect(models.filter((m) => m.startsWith("gpt-"))).toEqual([]);
    expect(models).not.toContain("gemini-3.1-flash-lite-preview");
    expect(models).toContain("gemini-2.5-pro");
  });

  test("an EU override cannot pick a US-only gateway model", () => {
    const eu = env({ ASSEMBLYAI_API_KEY: "k", STUDIO_LLM_REGION: "eu" });
    expect(resolveStudioSelection({ provider: "assemblyai", model: "gpt-5.2" }, eu)).toBeNull();
    expect(
      resolveStudioSelection({ provider: "assemblyai", model: "claude-opus-4-6" }, eu),
    ).toMatchObject({ model: "claude-opus-4-6" });
  });

  test("an env-only provider contributes the single model it runs", () => {
    const options = studioLlmOptions(
      env({ STUDIO_LLM_PROVIDER: "groq", STUDIO_LLM_MODEL: "llama-3.3-70b", GROQ_API_KEY: "k" }),
    );
    expect(options.providers).toEqual([
      { provider: "groq", label: "Groq", models: ["llama-3.3-70b"] },
    ]);
  });

  test("a keyed provider with no curated models and no env selection is omitted", () => {
    // XAI_API_KEY alone: xai has no curated list and is not the default.
    const options = studioLlmOptions(env({ ANTHROPIC_API_KEY: "k", XAI_API_KEY: "k" }));
    expect(options.providers.map((p) => p.provider)).toEqual(["anthropic"]);
  });
});

describe("resolveStudioSelection", () => {
  const both = env({ ASSEMBLYAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" });

  test("accepts an offered provider/model pair", () => {
    expect(
      resolveStudioSelection({ provider: "anthropic", model: "claude-opus-5" }, both),
    ).toMatchObject({ provider: "anthropic", model: "claude-opus-5", envVar: "ANTHROPIC_API_KEY" });
  });

  test("rejects a model the provider does not offer", () => {
    expect(resolveStudioSelection({ provider: "anthropic", model: "gpt-5.2" }, both)).toBeNull();
  });

  test("rejects a provider whose key the host lacks", () => {
    expect(resolveStudioSelection({ provider: "groq", model: "llama-3.3-70b" }, both)).toBeNull();
  });

  test("rejects unknown providers and partial input", () => {
    expect(resolveStudioSelection({ provider: "nope", model: "x" }, both)).toBeNull();
    expect(resolveStudioSelection({ provider: "anthropic" }, both)).toBeNull();
    expect(resolveStudioSelection({ model: "claude-opus-5" }, both)).toBeNull();
    expect(resolveStudioSelection({}, both)).toBeNull();
  });

  test("studioModel honours a valid override and rejects an invalid one", () => {
    const picked = studioModel({ provider: "anthropic", model: "claude-opus-5" }, both);
    expect((picked as { modelId: string }).modelId).toBe("claude-opus-5");
    expect(() => studioModel({ provider: "anthropic", model: "nope" }, both)).toThrow(
      /is not available on this server/,
    );
  });

  test("the gateway region applies to an overridden gateway model too", () => {
    const eu = env({ ASSEMBLYAI_API_KEY: "k", STUDIO_LLM_REGION: "eu" });
    expect(
      resolveStudioSelection({ provider: "assemblyai", model: "claude-haiku-4-5-20251001" }, eu)
        ?.descriptor,
    ).toMatchObject({
      kind: "assemblyai",
      options: { model: "claude-haiku-4-5-20251001", region: "eu" },
    });
  });
});
