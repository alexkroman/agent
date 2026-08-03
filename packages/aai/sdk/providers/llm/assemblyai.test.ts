// Copyright 2026 the AAI authors. MIT license.
/** Unit tests for the AssemblyAI LLM Gateway descriptor factory. */

import { describe, expect, it } from "vitest";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL, assemblyAILlm } from "./assemblyai.ts";

describe("assemblyAILlm (LLM factory)", () => {
  it("defaults the model to gpt-5.5", () => {
    expect(ASSEMBLYAI_LLM_DEFAULT_MODEL).toBe("gpt-5.5");
    expect(assemblyAILlm().options.model).toBe("gpt-5.5");
  });

  it("keeps an explicit model", () => {
    expect(assemblyAILlm({ model: "claude-sonnet-4-6" }).options.model).toBe("claude-sonnet-4-6");
  });

  it("carries reasoningEffort through as descriptor data", () => {
    expect(assemblyAILlm({ reasoningEffort: "none" }).options.reasoningEffort).toBe("none");
    expect(assemblyAILlm().options.reasoningEffort).toBeUndefined();
  });
});
