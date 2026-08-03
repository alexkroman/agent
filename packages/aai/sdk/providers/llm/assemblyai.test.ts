// Copyright 2026 the AAI authors. MIT license.
/** Unit tests for the AssemblyAI LLM Gateway descriptor factory. */

import { describe, expect, it } from "vitest";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL, assemblyAI } from "./assemblyai.ts";

describe("assemblyAI (LLM factory)", () => {
  it("defaults the model to gpt-5.5", () => {
    expect(ASSEMBLYAI_LLM_DEFAULT_MODEL).toBe("gpt-5.5");
    expect(assemblyAI().options.model).toBe("gpt-5.5");
  });

  it("keeps an explicit model", () => {
    expect(assemblyAI({ model: "claude-sonnet-4-6" }).options.model).toBe("claude-sonnet-4-6");
  });

  it("carries reasoningEffort through as descriptor data", () => {
    expect(assemblyAI({ reasoningEffort: "none" }).options.reasoningEffort).toBe("none");
    expect(assemblyAI().options.reasoningEffort).toBeUndefined();
  });
});
