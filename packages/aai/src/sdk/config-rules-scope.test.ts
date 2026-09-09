// Copyright 2026 the AAI authors. MIT license.
/**
 * The config rules that are about SCOPE — which declarations a mode may carry —
 * and the two serialization decisions that go with them.
 *
 * A sibling of `config-rules.test.ts` rather than more of it: that file was at
 * the test-length cap, and everything here is one question asked three ways —
 * what happens to a field the running mode cannot honour. The answer this SDK
 * gives is always the same, and the tests exist because the alternative
 * (accept it and do nothing) is silent by construction.
 *
 * The MODEL-TUNING arm of that question is deliberately not here. It lives in
 * `agent-model-tuning.test.ts`, beside the `MODEL_TUNING_FIELDS` table the
 * refusal derives its field list from, so the cases come from the table rather
 * than from a fixture kept in step with it. This file used to declare that
 * fixture too and loop it against the same message — two spellings of one rule,
 * of which only one could fail when a sixth knob landed. The guardrail arm
 * below is the mirror image, and its table is pinned in
 * `agent-guardrails.test.ts` for the same reason.
 */

import { describe, expect, test } from "vitest";
import { rawConfig } from "./_test-utils.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";

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
