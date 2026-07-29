// Copyright 2026 the AAI authors. MIT license.
// Studio chat LLM selection — host-env defaults and overrides. The provider
// is host-configured; a request may switch models within that provider's own
// list (studioLlmModels), never beyond it.

import { describe, expect, test } from "vitest";
import {
  ASSEMBLYAI_GATEWAY_MODELS,
  isStudioLlmConfigured,
  selectStudioLlm,
  studioLlmInfo,
  studioLlmModels,
  studioModel,
} from "./studio-llm.ts";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

describe("LLM provider selection", () => {
  const noEnv = env({});

  test("nothing configured → null / unconfigured", () => {
    expect(selectStudioLlm(noEnv)).toBeNull();
    expect(isStudioLlmConfigured(noEnv)).toBe(false);
    expect(studioLlmInfo(noEnv)).toBeNull();
    expect(() => studioModel(noEnv)).toThrow(/not configured/);
  });

  test("prefers the AssemblyAI LLM Gateway when its key is present", () => {
    const both = env({ ASSEMBLYAI_API_KEY: "k", ANTHROPIC_API_KEY: "k2" });
    expect(selectStudioLlm(both)).toMatchObject({ provider: "assemblyai", model: "gpt-5.5" });
    expect(studioLlmInfo(both)).toEqual({
      provider: "assemblyai",
      model: "gpt-5.5",
      models: [...ASSEMBLYAI_GATEWAY_MODELS],
    });
    expect((studioModel(both) as { modelId: string }).modelId).toBe("gpt-5.5");
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
    expect((studioModel(explicit) as { modelId: string }).modelId).toBe("gpt-4.1");
  });

  test("gateway EU region flows into the descriptor and defaults to Claude", () => {
    // gpt-5.5 leads the US list but OpenAI models are US-only, so the EU
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
    expect(() => studioModel(keyless)).toThrow(/ANTHROPIC_API_KEY is not set/);
  });
});

describe("per-request model switching", () => {
  const gatewayEnv = env({ ASSEMBLYAI_API_KEY: "k" });

  test("studioLlmModels lists the gateway models when configured", () => {
    expect(studioLlmModels(gatewayEnv)).toEqual([...ASSEMBLYAI_GATEWAY_MODELS]);
    expect(studioLlmInfo(gatewayEnv)).toMatchObject({
      provider: "assemblyai",
      model: "gpt-5.5",
      models: [...ASSEMBLYAI_GATEWAY_MODELS],
    });
  });

  test("studioLlmModels is empty when unconfigured or misconfigured", () => {
    expect(studioLlmModels(env({}))).toEqual([]);
    // Provider selected but its key missing: nothing is runnable.
    expect(studioLlmModels(env({ STUDIO_LLM_PROVIDER: "anthropic" }))).toEqual([]);
    // selectStudioLlm would throw; the list degrades to empty instead.
    expect(studioLlmModels(env({ STUDIO_LLM_PROVIDER: "nope" }))).toEqual([]);
  });

  test("an explicit STUDIO_LLM_MODEL leads the list without duplicating it", () => {
    const pinned = env({ ASSEMBLYAI_API_KEY: "k", STUDIO_LLM_MODEL: "custom-model" });
    expect(studioLlmModels(pinned)).toEqual(["custom-model", ...ASSEMBLYAI_GATEWAY_MODELS]);
    const pinnedToListed = env({ ASSEMBLYAI_API_KEY: "k", STUDIO_LLM_MODEL: "gpt-5" });
    const models = studioLlmModels(pinnedToListed);
    expect(models[0]).toBe("gpt-5");
    expect(models.filter((m) => m === "gpt-5")).toHaveLength(1);
  });

  test("a valid override switches the model on the same provider", () => {
    expect(selectStudioLlm(gatewayEnv, "claude-opus-4-7")).toMatchObject({
      provider: "assemblyai",
      model: "claude-opus-4-7",
    });
    expect((studioModel(gatewayEnv, "claude-opus-4-7") as { modelId: string }).modelId).toBe(
      "claude-opus-4-7",
    );
  });

  test("an override off the provider's list is a loud error", () => {
    expect(() => selectStudioLlm(gatewayEnv, "made-up-model")).toThrow(/not available/);
    expect(() => studioModel(gatewayEnv, "made-up-model")).toThrow(/not available/);
  });

  test("EU region filters the list and refuses US-only overrides", () => {
    const eu = env({ ASSEMBLYAI_API_KEY: "k", STUDIO_LLM_REGION: "eu" });
    const models = studioLlmModels(eu);
    expect(models[0]).toBe("claude-sonnet-4-6");
    expect(models).not.toContain("gpt-5.5");
    expect(() => selectStudioLlm(eu, "gpt-5.5")).toThrow(/not available/);
  });

  test("overriding with the configured default is always accepted", () => {
    // Even an off-list explicit STUDIO_LLM_MODEL can be re-stated.
    const pinned = env({ ASSEMBLYAI_API_KEY: "k", STUDIO_LLM_MODEL: "custom-model" });
    expect(selectStudioLlm(pinned, "custom-model")).toMatchObject({ model: "custom-model" });
  });
});

describe("env-only providers", () => {
  // No curated model list: each needs an explicit STUDIO_LLM_MODEL and is
  // reachable only via STUDIO_LLM_PROVIDER. One case per registry entry so a
  // wiring typo in `make`/`models` fails here, not at the first chat request.
  const ENV_ONLY = [
    ["openai", "OPENAI_API_KEY"],
    ["google", "GOOGLE_GENERATIVE_AI_API_KEY"],
    ["mistral", "MISTRAL_API_KEY"],
    ["xai", "XAI_API_KEY"],
    ["groq", "GROQ_API_KEY"],
    ["gateway", "AI_GATEWAY_API_KEY"],
  ] as const;

  test.each(ENV_ONLY)("%s builds a descriptor for an explicit model", (provider, envVar) => {
    const selection = selectStudioLlm(
      env({ STUDIO_LLM_PROVIDER: provider, STUDIO_LLM_MODEL: "some-model", [envVar]: "k" }),
    );
    expect(selection).toMatchObject({ provider, model: "some-model", envVar });
    expect(selection?.descriptor).toMatchObject({ kind: provider });
  });

  test.each(ENV_ONLY)("%s without STUDIO_LLM_MODEL is a loud error", (provider, envVar) => {
    // The empty curated list means there is no default to fall back to.
    expect(() => selectStudioLlm(env({ STUDIO_LLM_PROVIDER: provider, [envVar]: "k" }))).toThrow(
      /STUDIO_LLM_MODEL is required/,
    );
  });
});
