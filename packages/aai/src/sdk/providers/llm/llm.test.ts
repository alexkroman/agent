// Copyright 2026 the AAI authors. MIT license.
/** Unit tests for the one LLM descriptor factory, `llm()`. */

import { describe, expect, it } from "vitest";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL } from "./assemblyai.ts";
import { llm } from "./llm.ts";

// Mirrors the module-private TOOLS_REQUIRE_NO_REASONING. Duplicated rather
// than exported: the set is an implementation detail of the factory, and the
// spec only needs to know which side of it the default falls on.
const TOOLS_REQUIRE_NO_REASONING_IDS = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"];

const effortOf = (d: ReturnType<typeof llm>): unknown =>
  (d.options.providerOptions as { reasoningEffort?: unknown } | undefined)?.reasoningEffort;

describe("llm()", () => {
  it("puts the provider on `kind` and the model in `options`", () => {
    const d = llm({ provider: "anthropic", model: "some-model" });
    expect(d).toEqual({ kind: "anthropic", options: { model: "some-model" } });
  });

  it("is SERIALIZABLE and carries no credential", () => {
    // The whole reason there is no key parameter: a descriptor is baked into a
    // deployed agent's config and crosses a wire.
    const d = llm({ provider: "cerebras", model: "m", apiKeyEnv: "MY_KEY" });
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(d.options).toEqual({ model: "m", apiKeyEnv: "MY_KEY" });
  });

  it("carries baseUrl and providerOptions as data, COPIED rather than captured", () => {
    const providerOptions = { temperature: 0.2 };
    const d = llm({
      provider: "my-vendor",
      model: "m",
      baseUrl: "https://llm.example.test/v1",
      providerOptions,
    });
    providerOptions.temperature = 0.9;
    expect(d.options).toEqual({
      model: "m",
      baseUrl: "https://llm.example.test/v1",
      providerOptions: { temperature: 0.2 },
    });
  });

  it("the AssemblyAI default model is tool-capable", () => {
    // The invariant, not the incidental fact: the default model must be able
    // to call tools, because that is what the string shorthand and every unset
    // pipeline stage resolve to. Two ways to satisfy it — a default INSIDE the
    // set with `"none"` filled in, or one OUTSIDE it that needs no switch.
    const d = llm({ provider: "assemblyai", model: ASSEMBLYAI_LLM_DEFAULT_MODEL });
    const requiresNone = TOOLS_REQUIRE_NO_REASONING_IDS.includes(ASSEMBLYAI_LLM_DEFAULT_MODEL);
    expect(requiresNone ? effortOf(d) : "none").toBe("none");
  });

  // The gateway rejects a tool-carrying request on the 5.6 models at any
  // non-"none" reasoning effort — including the server-side default — and
  // streaming reports that as a bare 500.
  describe("AssemblyAI models that reject tools unless reasoning is off", () => {
    it.each(TOOLS_REQUIRE_NO_REASONING_IDS)('defaults %s to "none"', (model) => {
      expect(effortOf(llm({ provider: "assemblyai", model }))).toBe("none");
    });

    it("leaves an explicit effort alone — naming a value is deliberate", () => {
      const d = llm({
        provider: "assemblyai",
        model: "gpt-5.6-luna",
        providerOptions: { reasoningEffort: "low", region: "eu" },
      });
      expect(d.options.providerOptions).toEqual({ reasoningEffort: "low", region: "eu" });
    });

    it("does not touch models with no such constraint", () => {
      const d = llm({ provider: "assemblyai", model: "claude-sonnet-5" });
      expect(d.options).toEqual({ model: "claude-sonnet-5" });
    });

    it("never fills reasoning on ANOTHER provider serving a similarly named id", () => {
      expect(llm({ provider: "openai", model: "gpt-5.6-luna" }).options).toEqual({
        model: "gpt-5.6-luna",
      });
    });
  });
});
