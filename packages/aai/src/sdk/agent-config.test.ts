// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { rawConfig } from "./_test-utils.ts";
import {
  type AgentConfig,
  AgentConfigSchema,
  HOST_ONLY_AGENT_FIELDS,
  type HostOnlyAgentField,
  KNOWN_AGENT_FIELDS,
  ProviderDescriptorSchema,
  toAgentConfig,
} from "./agent-config.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import type { AgentDef } from "./types.ts";

// The single subtraction the config-mapping design rests on: every AgentDef
// field must be either serializable (present in AgentConfigSchema) or named
// in HOST_ONLY_AGENT_FIELDS. A field added to AgentDef alone fails here
// instead of silently vanishing at the serialization boundary.
test("every AgentDef field is serialized or explicitly host-only", () => {
  type Dropped = Exclude<keyof AgentDef, keyof AgentConfig | HostOnlyAgentField>;
  expectTypeOf<Dropped>().toEqualTypeOf<never>();
});
describe("AgentConfigSchema", () => {
  const base = { name: "a", systemPrompt: "p", greeting: "g" };

  test("accepts minBargeInWords above 1", () => {
    expect(AgentConfigSchema.safeParse({ ...base, minBargeInWords: 5 }).success).toBe(true);
  });

  test("rejects interruption.minWords below 1", () => {
    expect(AgentConfigSchema.safeParse({ ...base, interruption: { minWords: 0 } }).success).toBe(
      false,
    );
  });

  test.each(["s2s", "pipeline"] as const)("accepts mode: %s", (mode) => {
    expect(AgentConfigSchema.safeParse({ ...base, mode }).success).toBe(true);
  });

  test("rejects unknown mode", () => {
    expect(AgentConfigSchema.safeParse({ ...base, mode: "hybrid" }).success).toBe(false);
  });
});

describe("toAgentConfig", () => {
  const base = { name: "a", systemPrompt: "p", greeting: "g" };
  const desc = (kind: string) => ({ kind, options: {} });

  test("omits every optional field that is unset (no undefined-valued keys)", () => {
    // A source with no providers gets the default AssemblyAI pipeline
    // injected; pin to S2S so this test stays about unset-field omission.
    const config = toAgentConfig({ ...base, mode: "s2s", s2s: desc("assemblyai") });
    expect(config).toEqual({ ...base, s2s: desc("assemblyai"), mode: "s2s" });
    // `toEqual` treats a present-but-undefined key as absent, so check key
    // presence explicitly — the config crosses a structured-clone/JSON
    // boundary where phantom keys are visible.
    expect(Object.keys(config).sort()).toEqual(["greeting", "mode", "name", "s2s", "systemPrompt"]);
  });

  test("a systemPrompt RESOLVER is DROPPED — the wire carries the schema default", () => {
    // This test used to assert the opposite: that a nullary thunk was
    // SNAPSHOTTED here and the config carried the string it answered with. That
    // was right for a thunk and is wrong for the resolver `systemPrompt` now
    // takes, which is handed the live session (`AgentSystemPrompt`'s function arm) — there is
    // no session at serialization time, so there is nothing honest to snapshot
    // and a value taken here would be one turn's answer frozen for the life of
    // the deployment. Not a regression: what resolves per request is the LIVE
    // definition, in the runtime (`aai-runtime/src/runtime/system-prompt.ts`), which folds the
    // resolver's answer in under the same precedence header a string lands
    // under. The config is the SERIALIZABLE shape, so the key is dropped and
    // `AgentConfigSchema` supplies `DEFAULT_SYSTEM_PROMPT` for it.
    const config = toAgentConfig({ ...base, systemPrompt: () => "computed" });
    expect(config.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(typeof config.systemPrompt).toBe("string");
  });

  test("the resolver is never CALLED on the way to a config", () => {
    // The other half, and the one that would fail silently: calling it here
    // would ask an author's function to answer with no session anywhere, which
    // is exactly what a resolver reading a slot cannot do.
    const systemPrompt = vi.fn(() => "computed");
    toAgentConfig({ ...base, systemPrompt });
    expect(systemPrompt).not.toHaveBeenCalled();
  });

  test("injects the default AssemblyAI pipeline when no providers are declared", () => {
    const config = toAgentConfig(base);
    expect(config.mode).toBe("pipeline");
    expect(config.stt?.kind).toBe("assemblyai");
    expect(config.llm?.kind).toBe("assemblyai");
    expect(config.tts?.kind).toBe("assemblyai");
    expect(config.s2s).toBeUndefined();
  });

  test("propagates every optional field in pipeline mode", () => {
    const src = {
      ...base,
      sttPrompt: "domain terms",
      maxSteps: 7,
      toolChoice: "required" as const,
      builtinTools: ["think"] as const,
      idleTimeoutMs: 1000,
      silence: { deadAirCoverMs: 2500, nudge: { afterMs: 9000, prompt: "nudge" } },
      interruption: { minWords: 3, minDurationMs: 250, resumeFalseInterruption: true },
      turnTaking: { detection: "manual", preemptiveGeneration: false },
      stt: desc("assemblyai"),
      llm: desc("anthropic"),
      tts: desc("cartesia"),
    };
    expect(toAgentConfig(src)).toEqual({ ...src, mode: "pipeline" });
  });

  test("propagates the s2s descriptor and keeps the pipeline triple absent", () => {
    const config = toAgentConfig({ ...base, mode: "s2s", s2s: desc("assemblyai") });
    expect(config.mode).toBe("s2s");
    expect(config.s2s).toEqual(desc("assemblyai"));
    expect("stt" in config).toBe(false);
    expect("llm" in config).toBe(false);
    expect("tts" in config).toBe(false);
  });

  test("an authored `mode` the providers contradict is REFUSED, not overwritten", () => {
    // The source's `mode` is the AUTHORED one now, so a disagreement is a
    // declaration that says two things — refused by name rather than resolved
    // in favour of whichever field the copy happened to read last.
    expect(() => rawConfig({ ...base, s2s: desc("assemblyai"), mode: "pipeline" })).toThrow(
      /`s2s` is the speech-to-speech descriptor — it has no effect on a "pipeline" agent/,
    );
  });

  test('…and `mode: "s2s"` with no descriptor never falls back to a pipeline', () => {
    expect(() => rawConfig({ ...base, mode: "s2s" })).toThrow(
      /needs the `s2s` descriptor it selects/,
    );
  });

  test("the wire carries the authored mode unchanged, a workflow app's included", () => {
    expect(rawConfig({ ...base, mode: "workflow-app" }).mode).toBe("workflow-app");
    expect(rawConfig({ ...base, mode: "text" }).mode).toBe("text");
    expect(rawConfig(base).mode).toBe("pipeline");
  });
});

describe("the field lists", () => {
  test("KNOWN_AGENT_FIELDS is every serialized field plus every host-only one", () => {
    for (const field of Object.keys(AgentConfigSchema.shape)) {
      expect(KNOWN_AGENT_FIELDS.has(field), field).toBe(true);
    }
    for (const field of HOST_ONLY_AGENT_FIELDS)
      expect(KNOWN_AGENT_FIELDS.has(field), field).toBe(true);
  });

  test("a host-only field is never one the schema also serializes", () => {
    const serialized = new Set(Object.keys(AgentConfigSchema.shape));
    for (const field of HOST_ONLY_AGENT_FIELDS) expect(serialized.has(field), field).toBe(false);
  });
});

describe("ProviderDescriptorSchema", () => {
  test("is a non-empty kind and an options record", () => {
    expect(ProviderDescriptorSchema.safeParse({ kind: "assemblyai", options: {} }).success).toBe(
      true,
    );
    expect(ProviderDescriptorSchema.safeParse({ kind: "", options: {} }).success).toBe(false);
    expect(ProviderDescriptorSchema.safeParse({ kind: "x" }).success).toBe(false);
  });
});
