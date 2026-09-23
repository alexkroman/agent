// Copyright 2026 the AAI authors. MIT license.
/** Unit tests for the AssemblyAI LLM Gateway constants and its reasoning-effort rule. */

import { describe, expect, it } from "vitest";
import {
  ASSEMBLYAI_LLM_API_KEY_ENV,
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  ASSEMBLYAI_LLM_KIND,
  type AssemblyAIReasoningEffort,
  assemblyAIReasoningEffort,
} from "./assemblyai.ts";

describe("assemblyAIReasoningEffort", () => {
  it("fills `none` for a model that rejects tools with reasoning on", () => {
    for (const model of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
      expect(assemblyAIReasoningEffort(model, undefined)).toBe("none");
    }
  });

  it("covers the default model, since every agent carries a tool", () => {
    // `think` is a default built-in, so a default outside the set would 500 on
    // every turn — the failure the set exists to prevent.
    expect(assemblyAIReasoningEffort(ASSEMBLYAI_LLM_DEFAULT_MODEL, undefined)).toBe("none");
  });

  it("leaves a model outside the set unset — `none` is a 400 on some of them", () => {
    expect(assemblyAIReasoningEffort("gemini-3.7-flash", undefined)).toBeUndefined();
    expect(assemblyAIReasoningEffort("qwen3-next-80b-a3b", undefined)).toBeUndefined();
  });

  it("keeps an EXPLICIT effort on every model, inside the set or not", () => {
    const efforts: AssemblyAIReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];
    for (const effort of efforts) {
      expect(assemblyAIReasoningEffort("gpt-5.6-luna", effort)).toBe(effort);
      expect(assemblyAIReasoningEffort("gemini-3.7-flash", effort)).toBe(effort);
    }
  });

  it("matches the model id exactly, not by prefix", () => {
    expect(assemblyAIReasoningEffort("gpt-5.6-luna-preview", undefined)).toBeUndefined();
    expect(assemblyAIReasoningEffort("GPT-5.6-LUNA", undefined)).toBeUndefined();
  });
});

describe("gateway constants", () => {
  it("name the kind, the shared STT key, and two HTTPS /v1 endpoints", () => {
    expect(ASSEMBLYAI_LLM_KIND).toBe("assemblyai");
    expect(ASSEMBLYAI_LLM_API_KEY_ENV).toBe("ASSEMBLYAI_API_KEY");
    for (const url of [ASSEMBLYAI_LLM_GATEWAY_URL, ASSEMBLYAI_LLM_GATEWAY_EU_URL]) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.pathname).toBe("/v1");
    }
    expect(new URL(ASSEMBLYAI_LLM_GATEWAY_EU_URL).hostname).toMatch(/\.eu\./);
    expect(new URL(ASSEMBLYAI_LLM_GATEWAY_URL).hostname).not.toMatch(/\.eu\./);
  });
});
