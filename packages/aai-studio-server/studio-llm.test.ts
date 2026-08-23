// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { STUDIO_LLM_MODELS, studioLlmInfo, studioLlmModelId } from "./studio-llm.ts";

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

describe("studioLlmModelId", () => {
  test("defaults to the first gateway model", () => {
    expect(studioLlmModelId(env({}))).toBe(STUDIO_LLM_MODELS[0]);
    expect(studioLlmModelId(env({}))).toBe("gpt-5.5");
  });

  test("STUDIO_LLM_MODEL overrides; empty string means unset", () => {
    expect(studioLlmModelId(env({ STUDIO_LLM_MODEL: "gpt-5-mini" }))).toBe("gpt-5-mini");
    expect(studioLlmModelId(env({ STUDIO_LLM_MODEL: "" }))).toBe("gpt-5.5");
  });

  test("the EU region default skips US-only models", () => {
    // qwen/gpt lead the US list but are not served by the EU endpoint.
    expect(studioLlmModelId(env({ STUDIO_LLM_REGION: "eu" }))).toBe("claude-sonnet-4-6");
  });
});

describe("studioLlmInfo", () => {
  test("reports the gateway provider and resolved model", () => {
    expect(studioLlmInfo(env({}))).toEqual({ provider: "assemblyai", model: "gpt-5.5" });
    expect(studioLlmInfo(env({ STUDIO_LLM_MODEL: "gpt-5" }))).toEqual({
      provider: "assemblyai",
      model: "gpt-5",
    });
  });
});
