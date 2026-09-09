// Copyright 2026 the AAI authors. MIT license.
/**
 * The config rules that are about SCOPE — which declarations a mode may carry —
 * and the two serialization decisions that go with them.
 *
 * A sibling of `config-rules.test.ts` rather than more of it: that file was at
 * the test-length cap, and everything here is one question asked five ways —
 * what happens to a field the running mode cannot honour. The answer this SDK
 * gives is always the same, and the tests exist because the alternative
 * (accept it and do nothing) is silent by construction.
 */

import { describe, expect, test } from "vitest";
import type { AgentConfig } from "./manifest-barrel.ts";
import { toAgentConfig } from "./manifest-barrel.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";

/**
 * A config built from a RAW object, skipping `agent()`.
 *
 * The same helper `config-rules.test.ts` uses and for the same reason: these
 * rules run at the config boundary, which is the layer a hand-written
 * `export default {...}` also crosses, and the cast is what lets a case state a
 * field combination the authoring types refuse.
 */
function rawConfig(fields: Record<string, unknown>): AgentConfig {
  return toAgentConfig(fields as Parameters<typeof toAgentConfig>[0]);
}

describe("the model-tuning knobs share ONE scope rule", () => {
  // Five fields, one reason: this runtime assembles the request they describe,
  // and in s2s mode it assembles none. The list is derived from
  // `MODEL_TUNING_FIELDS`, so a knob added there and not here is still refused.
  const knobs = {
    temperature: 0.2,
    maxOutputTokens: 400,
    maxRetries: 0,
    resetToolChoice: false,
    usageLimits: { totalTokens: 10_000 },
  } as const;

  for (const [field, value] of Object.entries(knobs)) {
    test(`${field} reaches a pipeline agent's config`, () => {
      expect(rawConfig({ name: "Line", [field]: value })[field as keyof AgentConfig]).toEqual(
        value,
      );
    });

    test(`${field} reaches a TEXT agent's config — none of these is voice-specific`, () => {
      expect(
        rawConfig({ name: "Docs", text: true, [field]: value })[field as keyof AgentConfig],
      ).toEqual(value);
    });

    test(`${field} is REFUSED in s2s mode rather than silently dropped`, () => {
      expect(() => rawConfig({ name: "Line", s2s: assemblyAIS2s(), [field]: value })).toThrow(
        new RegExp(`${field} has no effect in s2s mode`),
      );
    });
  }

  test("`maxRetries: 0` survives — a `??` default would swallow it", () => {
    // The value most worth setting on a live call, and the one an accidental
    // `?? DEFAULT` would replace with the vendor's own backoff.
    expect(rawConfig({ name: "Line", maxRetries: 0 }).maxRetries).toBe(0);
  });

  test("`resetToolChoice` is absent by default, so the runtime owns the default", () => {
    expect(rawConfig({ name: "Line" }).resetToolChoice).toBeUndefined();
  });
});

describe("guardrail scope", () => {
  const guardrail = (): true => true;

  test("a pipeline agent may declare both, and neither crosses the wire", () => {
    // Functions: host-only by construction, like `tools` and `events`. The
    // guest holds the agent's own module, which is the only side that could
    // call one.
    const config = rawConfig({
      name: "Line",
      inputGuardrails: [guardrail],
      outputGuardrails: [guardrail],
    });
    expect(config).not.toHaveProperty("inputGuardrails");
    expect(config).not.toHaveProperty("outputGuardrails");
    expect(config.mode).toBe("pipeline");
  });

  test("an S2S agent is REFUSED, and the message says why a block is impossible", () => {
    // The refusal that matters most in this file: a safety control that is
    // accepted and quietly does nothing costs exactly the thing it was
    // declared to prevent.
    expect(() =>
      rawConfig({ name: "Line", s2s: assemblyAIS2s(), outputGuardrails: [guardrail] }),
    ).toThrow(/outputGuardrails requires pipeline mode/);
    expect(() =>
      rawConfig({ name: "Line", s2s: assemblyAIS2s(), outputGuardrails: [guardrail] }),
    ).toThrow(/the caller has already heard it/);
  });

  test("a TEXT agent is refused too, for a structural reason rather than a physical one", () => {
    expect(() => rawConfig({ name: "Docs", text: true, inputGuardrails: [guardrail] })).toThrow(
      /inputGuardrails requires pipeline mode/,
    );
    expect(() => rawConfig({ name: "Docs", text: true, inputGuardrails: [guardrail] })).toThrow(
      /returns the AI SDK's own result/,
    );
  });
});

describe("description", () => {
  test("it crosses the wire, unlike the other things an author declares", () => {
    // The point of the field: a registry, an A2A card and the studio's picker
    // all read a stored config and none of them runs the agent.
    expect(rawConfig({ name: "Line", description: "Books dental appointments" }).description).toBe(
      "Books dental appointments",
    );
  });

  test("unset stays unset", () => {
    expect(rawConfig({ name: "Line" }).description).toBeUndefined();
  });
});

describe("a systemPrompt RESOLVER", () => {
  test("is dropped from the wire, and the config falls back to the default prompt", () => {
    // A function cannot be serialized, and the deny-list cannot express "this
    // key, but only one of its two shapes". The runtime holds the agent's own
    // module and calls it per request.
    const config = rawConfig({ name: "Line", systemPrompt: () => "phase: greeting" });
    expect(typeof config.systemPrompt).toBe("string");
    expect(config.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("a plain string is untouched", () => {
    expect(
      rawConfig({ name: "Line", systemPrompt: "Only discuss the catalog." }).systemPrompt,
    ).toBe("Only discuss the catalog.");
  });
});
