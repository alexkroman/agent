// Copyright 2026 the AAI authors. MIT license.
/** Unit tests for the AssemblyAI LLM Gateway descriptor factory. */

import { describe, expect, it } from "vitest";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL, assemblyAILlm } from "./assemblyai.ts";

// Mirrors the module-private TOOLS_REQUIRE_NO_REASONING. Duplicated rather
// than exported: the set is an implementation detail of the factory, and the
// spec only needs to know which side of it the default falls on.
const TOOLS_REQUIRE_NO_REASONING_IDS = ["gpt-5.6-luna", "gpt-5.6-terra"];

describe("assemblyAILlm (LLM factory)", () => {
  it("defaults the model to qwen3-next-80b-a3b", () => {
    expect(ASSEMBLYAI_LLM_DEFAULT_MODEL).toBe("qwen3-next-80b-a3b");
    expect(assemblyAILlm().options.model).toBe("qwen3-next-80b-a3b");
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

    // The default model IS one of them, so the bare factory carries the fill
    // too — `assemblyAILlm()` with no arguments has to be a descriptor that can
    // call tools, since that is what the string shorthand and every unset
    // pipeline stage resolve to.
    it("leaves the bare factory tool-capable, whichever side of the set the default sits", () => {
      // The invariant, not the incidental fact: `assemblyAILlm()` with no
      // arguments must be able to call tools, because that is what the string
      // shorthand and every unset pipeline stage resolve to. Two ways to
      // satisfy it — a default INSIDE the set with `"none"` filled in, or one
      // OUTSIDE it that needs no switch. Pinned this way so changing the
      // default id cannot silently produce the third, broken combination.
      const { model, reasoningEffort } = assemblyAILlm().options;
      const requiresNone = TOOLS_REQUIRE_NO_REASONING_IDS.includes(model as string);
      expect(requiresNone ? reasoningEffort : "none").toBe("none");
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
