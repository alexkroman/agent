// Copyright 2026 the AAI authors. MIT license.
// The fast/slow DECLARATION, on the authoring side. UNIT tier.
//
// The module is types plus four constants, so what a spec can claim about it is
// the constants' values and the one thing that actually matters at this layer:
// that `twoTier` is accepted by `agent()`, survives `toAgentConfig`, and is
// refused for an S2S agent — which is the group rule it joined
// `AgentModelTuning` for.

import { describe, expect, test } from "vitest";
import { TwoTierConfigSchema, toAgentConfig } from "./agent-config.ts";
import { agent } from "./define.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";
import {
  DEFAULT_SLOW_TIER_CONTEXT_MESSAGES,
  DEFAULT_SLOW_TIER_EFFORT,
  DEFAULT_SLOW_TIER_TIMEOUT_MS,
  MAX_STATE_DIGEST_CHARS,
} from "./two-tier.ts";

describe("the documented defaults", () => {
  test("are the values the docs name", () => {
    // Pinned because each one is quoted in a `@defaultValue` an author reads,
    // and a constant that drifts from its own doc is worse than no doc.
    expect(DEFAULT_SLOW_TIER_EFFORT).toBe("high");
    expect(DEFAULT_SLOW_TIER_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_SLOW_TIER_CONTEXT_MESSAGES).toBe(24);
    expect(MAX_STATE_DIGEST_CHARS).toBe(2000);
  });

  test("the digest cap leaves room for a real summary plus entries", () => {
    // It rides on EVERY fast-tier request, so it is a budget rather than a
    // limit — big enough for the 2-4 sentences the slow tier is asked for and
    // a dozen entries, small enough not to grow the prompt for the length of a
    // call.
    expect(MAX_STATE_DIGEST_CHARS).toBeGreaterThan(500);
    expect(MAX_STATE_DIGEST_CHARS).toBeLessThan(8000);
  });
});

describe("agent({ twoTier })", () => {
  test("survives `toAgentConfig`, so a DEPLOYED agent has the gate too", () => {
    // The failure this prevents is the `guest-route-exposure` shape: a feature
    // that works under `aai dev` and is silently absent once deployed, because
    // the declaration never reached the wire.
    const config = toAgentConfig(
      agent({
        name: "Desk",
        twoTier: { effort: "low", timeoutMs: 9000, completionGate: false, contextMessages: 4 },
      }),
    );
    expect(config.twoTier).toEqual({
      effort: "low",
      timeoutMs: 9000,
      completionGate: false,
      contextMessages: 4,
    });
  });

  test("carries a provider DESCRIPTOR for the slow tier across the wire", () => {
    const config = toAgentConfig(
      agent({ name: "Desk", twoTier: { llm: { kind: "anthropic", options: { model: "m" } } } }),
    );
    expect(config.twoTier?.llm).toEqual({ kind: "anthropic", options: { model: "m" } });
  });

  test("takes the model-id STRING shorthand `agent({ llm })` takes", () => {
    const config = toAgentConfig(agent({ name: "Desk", twoTier: { llm: "openai/gpt-5.5" } }));
    expect(config.twoTier?.llm).toBe("openai/gpt-5.5");
  });

  test("an absent declaration puts NOTHING on the wire", () => {
    // The off-switch, at the config layer: `resolveTwoTier(undefined)` is what
    // every consumer gates on.
    expect(toAgentConfig(agent({ name: "Desk" }))).not.toHaveProperty("twoTier");
  });

  test("is REFUSED for an S2S agent, by name", () => {
    // The group rule it joined `AgentModelTuning` for, and structural rather
    // than merely consistent: there the provider runs the loop and calls the
    // tool itself, so there is no moment for a second tier to stand in.
    expect(() =>
      toAgentConfig({
        ...agent({ name: "Desk", s2s: assemblyAIS2s() }),
        twoTier: { effort: "high" },
      }),
    ).toThrow(/second model tier/);
  });

  test("a MISSPELLED field is refused at the boundary, not silently dropped", () => {
    // `.strict()`, unlike its neighbours: a typo in a field that decides
    // whether something is REFUSED would deploy an agent whose gate is off
    // when the author wrote the opposite, and the only symptom is a mutation
    // that went through.
    //
    // Asserted against the SCHEMA rather than through `toAgentConfig`, because
    // a typed call site cannot express the typo without a cast — and the thing
    // being tested is the WIRE boundary anyway, which is where an untyped
    // stored config arrives.
    expect(TwoTierConfigSchema.safeParse({ completionGat: false }).success).toBe(false);
    expect(TwoTierConfigSchema.safeParse({ completionGate: false }).success).toBe(true);
  });
});
