// Copyright 2026 the AAI authors. MIT license.
// Studio chat LLM selection — host-env defaults and overrides. The provider
// and model are host-configured; a request can never switch either.

import { describe, expect, test } from "vitest";
import {
  isStudioLlmConfigured,
  selectStudioLlm,
  studioLlmInfo,
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
    expect(selectStudioLlm(both)).toMatchObject({
      provider: "assemblyai",
      model: "qwen3-next-80b-a3b",
    });
    expect(studioLlmInfo(both)).toEqual({ provider: "assemblyai", model: "qwen3-next-80b-a3b" });
    expect((studioModel(both) as { modelId: string }).modelId).toBe("qwen3-next-80b-a3b");
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
    // qwen3-next-80b-a3b leads the US list but Qwen (like OpenAI) is US-only,
    // so the EU default falls to the first Claude model.
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
    ["openrouter", "OPENROUTER_API_KEY"],
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
