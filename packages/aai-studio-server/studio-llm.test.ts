// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import {
  ASSEMBLYAI_GATEWAY_MODELS,
  studioLlmInfo,
  studioLlmModelId,
  studioModel,
} from "./studio-llm.ts";

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

describe("studioLlmModelId", () => {
  test("defaults to the first gateway model", () => {
    expect(studioLlmModelId(env({}))).toBe(ASSEMBLYAI_GATEWAY_MODELS[0]);
    expect(studioLlmModelId(env({}))).toBe("qwen3-next-80b-a3b");
  });

  test("STUDIO_LLM_MODEL overrides; empty string means unset", () => {
    expect(studioLlmModelId(env({ STUDIO_LLM_MODEL: "gpt-5.5" }))).toBe("gpt-5.5");
    expect(studioLlmModelId(env({ STUDIO_LLM_MODEL: "" }))).toBe("qwen3-next-80b-a3b");
  });

  test("the EU region default skips US-only models", () => {
    // qwen/gpt lead the US list but are not served by the EU endpoint.
    expect(studioLlmModelId(env({ STUDIO_LLM_REGION: "eu" }))).toBe("claude-sonnet-4-6");
  });
});

describe("studioModel", () => {
  test("resolves a gateway model on the caller's key — no host env needed", () => {
    const model = studioModel("caller-key", env({}));
    expect((model as { modelId: string }).modelId).toBe("qwen3-next-80b-a3b");
  });

  test("refuses an empty caller key", () => {
    expect(() => studioModel("", env({}))).toThrow(/caller's AssemblyAI API key/);
  });

  test("never reads a platform key from env", () => {
    // A host ASSEMBLYAI_API_KEY in env must be irrelevant: only the caller
    // key argument selects and authenticates the model.
    const hostEnv = env({ ASSEMBLYAI_API_KEY: "platform-key-should-be-ignored" });
    expect(() => studioModel("", hostEnv)).toThrow(/caller's AssemblyAI API key/);
  });
});

describe("studioLlmInfo", () => {
  test("reports the gateway provider and resolved model", () => {
    expect(studioLlmInfo(env({}))).toEqual({ provider: "assemblyai", model: "qwen3-next-80b-a3b" });
    expect(studioLlmInfo(env({ STUDIO_LLM_MODEL: "gpt-5" }))).toEqual({
      provider: "assemblyai",
      model: "gpt-5",
    });
  });
});
