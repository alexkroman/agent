// Copyright 2026 the AAI authors. MIT license.
/** Unit tests for the AssemblyAI LLM Gateway descriptor factory. */

import { describe, expect, it } from "vitest";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL, assemblyAILlm } from "./assemblyai.ts";

describe("assemblyAILlm (LLM factory)", () => {
  it("defaults the model to gpt-5.6-luna", () => {
    expect(ASSEMBLYAI_LLM_DEFAULT_MODEL).toBe("gpt-5.6-luna");
    expect(assemblyAILlm().options.model).toBe("gpt-5.6-luna");
  });

  it("keeps an explicit model", () => {
    expect(assemblyAILlm({ model: "claude-sonnet-4-6" }).options.model).toBe("claude-sonnet-4-6");
  });

  it("carries reasoningEffort through as descriptor data", () => {
    expect(assemblyAILlm({ reasoningEffort: "none" }).options.reasoningEffort).toBe("none");
    expect(assemblyAILlm({ model: "gpt-5.5" }).options.reasoningEffort).toBeUndefined();
  });

  // The gateway rejects a tool-carrying request on the 5.6 models at any
  // non-"none" reasoning effort — including the server-side default, i.e.
  // sending no reasoning_effort at all — and streaming reports that as a bare
  // 500. Nearly every agent sends tools (DEFAULT_BUILTIN_TOOLS), so an unset
  // effort is not a usable descriptor state for these models.
  describe("models that reject tools unless reasoning is off", () => {
    it.each(["gpt-5.6-luna", "gpt-5.6-terra"])('defaults %s to "none"', (model) => {
      expect(assemblyAILlm({ model }).options.reasoningEffort).toBe("none");
    });

    it("covers the bare factory, since the default model is one of them", () => {
      expect(assemblyAILlm().options.reasoningEffort).toBe("none");
    });

    it("leaves an explicit effort alone — naming a value is deliberate", () => {
      expect(
        assemblyAILlm({ model: "gpt-5.6-luna", reasoningEffort: "low" }).options,
      ).toMatchObject({ reasoningEffort: "low" });
    });

    it("does not touch models with no such constraint", () => {
      expect(assemblyAILlm({ model: "claude-sonnet-5" }).options.reasoningEffort).toBeUndefined();
    });
  });
});
