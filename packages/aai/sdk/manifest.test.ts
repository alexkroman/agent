// Copyright 2025 the AAI authors. MIT license.
import fc from "fast-check";
import { describe, expect, expectTypeOf, test } from "vitest";
import { assertProviderTriple } from "./config-rules.ts";
import { type Manifest, parseManifest } from "./manifest.ts";
import type { AgentConfig, ToolSchema } from "./manifest-barrel.ts";
import { agentToolsToSchemas, toAgentConfig } from "./manifest-barrel.ts";
import { assemblyAIPipeline } from "./providers/assemblyai-pipeline.ts";
import { anthropic } from "./providers/llm/anthropic.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";
import { assemblyAIStt } from "./providers/stt/assemblyai.ts";
import { cartesia } from "./providers/tts/cartesia.ts";

describe("parseManifest", () => {
  test("minimal manifest requires only name", () => {
    const result = parseManifest({ name: "Simple Agent" });
    expect(result).toEqual({
      name: "Simple Agent",
      systemPrompt: expect.any(String),
      greeting: expect.any(String),
      sttPrompt: undefined,
      maxSteps: 10,
      toolChoice: "auto",
      idleTimeoutMs: undefined,
      builtinTools: ["think", "remember", "recall", "calculate"],
      tools: {},
      // No providers declared → the all-AssemblyAI pipeline is the default.
      ...assemblyAIPipeline(),
      mode: "pipeline",
    });
  });

  test("full manifest passes through all fields", () => {
    const input = {
      name: "Weather Agent",
      systemPrompt: "You are a weather bot.",
      greeting: "What city?",
      sttPrompt: "Celsius, Fahrenheit",
      builtinTools: ["web_search"],
      maxSteps: 10,
      toolChoice: "required" as const,
      idleTimeoutMs: 60_000,
      tools: {
        get_weather: {
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    };
    const result = parseManifest(input);
    expect(result.name).toBe("Weather Agent");
    expect(result.systemPrompt).toBe("You are a weather bot.");
    expect(result.tools.get_weather?.description).toBe("Get weather");
    expect(result.maxSteps).toBe(10);
    expect(result.toolChoice).toBe("required");
  });

  test("rejects manifest without name", () => {
    expect(() => parseManifest({})).toThrow();
  });

  test("accepts idleTimeoutMs: 0 (documented 'disable timer' value)", () => {
    const result = parseManifest({ name: "test", idleTimeoutMs: 0 });
    expect(result.idleTimeoutMs).toBe(0);
  });

  test("rejects negative idleTimeoutMs", () => {
    expect(() => parseManifest({ name: "test", idleTimeoutMs: -1 })).toThrow();
  });

  test("rejects unknown builtinTools", () => {
    expect(() => parseManifest({ name: "X", builtinTools: ["not_a_tool"] })).toThrow();
  });

  test("explicit builtinTools: [] overrides the cognitive defaults", () => {
    const result = parseManifest({ name: "X", builtinTools: [] });
    expect(result.builtinTools).toEqual([]);
  });
});

describe("property: parseManifest", () => {
  const optString = fc.option(fc.string(), { nil: undefined });
  const optMaxSteps = fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined });

  test("valid manifests always parse", () => {
    const validManifestArb = fc.record({
      name: fc.string({ minLength: 1 }),
      systemPrompt: optString,
      greeting: optString,
      maxSteps: optMaxSteps,
      toolChoice: fc.option(fc.constantFrom("auto" as const, "required" as const), {
        nil: undefined,
      }),
    });

    fc.assert(
      fc.property(validManifestArb, (manifest) => {
        const result = parseManifest(manifest);
        expect(result.name).toBe(manifest.name);
        expect(result.maxSteps).toBeGreaterThan(0);
        expect(["auto", "required"]).toContain(result.toolChoice);
      }),
    );
  });

  test("missing name throws", () => {
    const noNameArb = fc.record({
      systemPrompt: optString,
      greeting: optString,
      maxSteps: optMaxSteps,
    });

    fc.assert(
      fc.property(noNameArb, (obj) => {
        expect(() => parseManifest(obj)).toThrow();
      }),
    );
  });
});

describe("manifest type contracts", () => {
  test("parseManifest returns Manifest", () => {
    const result = parseManifest({ name: "test" });
    expectTypeOf(result).toEqualTypeOf<Manifest>();
  });

  test("parseManifest accepts unknown input", () => {
    expectTypeOf(parseManifest).parameter(0).toBeUnknown();
  });

  test("toAgentConfig returns AgentConfig", () => {
    const config = toAgentConfig({ name: "test", systemPrompt: "p", greeting: "g" });
    expectTypeOf(config).toEqualTypeOf<AgentConfig>();
  });

  test("agentToolsToSchemas returns ToolSchema[]", () => {
    const schemas = agentToolsToSchemas({});
    expectTypeOf(schemas).toEqualTypeOf<ToolSchema[]>();
  });
});

describe("parseManifest — mode classification", () => {
  const stubStt = assemblyAIStt({ model: "universal-3-5-pro" });
  const stubTts = cartesia({ voice: "v" });
  const stubLlm = anthropic({ model: "claude-haiku-4-5" });

  test("no providers ⇒ default AssemblyAI pipeline", () => {
    const parsed = parseManifest({
      name: "hello",
      systemPrompt: "hi",
    });
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.stt).toEqual(assemblyAIPipeline().stt);
    expect(parsed.llm).toEqual(assemblyAIPipeline().llm);
    expect(parsed.tts).toEqual(assemblyAIPipeline().tts);
  });

  test("s2s descriptor (assemblyAIS2s) ⇒ mode: 's2s', no pipeline injection", () => {
    const parsed = parseManifest({
      name: "hello",
      systemPrompt: "hi",
      s2s: assemblyAIS2s(),
    });
    expect(parsed.mode).toBe("s2s");
    expect(parsed.s2s).toEqual({ kind: "assemblyai", options: {} });
    expect(parsed.stt).toBeUndefined();
    expect(parsed.llm).toBeUndefined();
    expect(parsed.tts).toBeUndefined();
  });

  test("all three of stt/llm/tts set ⇒ mode: 'pipeline'", () => {
    const parsed = parseManifest({
      name: "hello",
      systemPrompt: "hi",
      stt: stubStt,
      llm: stubLlm,
      tts: stubTts,
    } as never);
    expect(parsed.mode).toBe("pipeline");
  });

  test("only stt set ⇒ throws", () => {
    expect(() =>
      parseManifest({
        name: "hello",
        stt: stubStt,
      } as never),
    ).toThrow(/stt, llm, and tts must be set together/);
  });

  test("stt + tts without llm ⇒ throws", () => {
    expect(() =>
      parseManifest({
        name: "hello",
        stt: stubStt,
        tts: stubTts,
      } as never),
    ).toThrow(/stt, llm, and tts must be set together/);
  });
});

describe("parseManifest — silence nudge", () => {
  const pipelineFields = {
    stt: assemblyAIStt({ model: "universal-3-5-pro" }),
    llm: anthropic({ model: "claude-haiku-4-5" }),
    tts: cartesia({ voice: "v" }),
  };

  test("accepts silenceTimeoutMs + silencePrompt in pipeline mode", () => {
    const m = parseManifest({
      name: "x",
      ...pipelineFields,
      silenceTimeoutMs: 15_000,
      silencePrompt: "Ask if the user is still there.",
    } as never);
    expect(m.silenceTimeoutMs).toBe(15_000);
    expect(m.silencePrompt).toBe("Ask if the user is still there.");
  });

  test("rejects silenceTimeoutMs in s2s mode", () => {
    expect(() =>
      parseManifest({ name: "x", s2s: assemblyAIS2s(), silenceTimeoutMs: 15_000 }),
    ).toThrow(/silenceTimeoutMs requires pipeline mode/);
  });

  test("rejects silencePrompt without silenceTimeoutMs", () => {
    expect(() =>
      parseManifest({
        name: "x",
        ...pipelineFields,
        silencePrompt: "Hello?",
      } as never),
    ).toThrow(/silencePrompt requires silenceTimeoutMs/);
  });

  test("rejects non-positive silenceTimeoutMs", () => {
    expect(() =>
      parseManifest({ name: "x", ...pipelineFields, silenceTimeoutMs: 0 } as never),
    ).toThrow();
  });

  test("toAgentConfig propagates the silence fields in pipeline mode", () => {
    const config = toAgentConfig({
      name: "x",
      systemPrompt: "p",
      greeting: "g",
      ...pipelineFields,
      silenceTimeoutMs: 20_000,
      silencePrompt: "Check in.",
    });
    expect(config.silenceTimeoutMs).toBe(20_000);
    expect(config.silencePrompt).toBe("Check in.");
  });

  test("toAgentConfig rejects silenceTimeoutMs in s2s mode", () => {
    expect(() =>
      toAgentConfig({
        name: "x",
        systemPrompt: "p",
        greeting: "g",
        s2s: assemblyAIS2s(),
        silenceTimeoutMs: 20_000,
      }),
    ).toThrow(/silenceTimeoutMs requires pipeline mode/);
  });
});

describe("parseManifest — pipeline voice tuning", () => {
  const pipelineFields = {
    stt: assemblyAIStt({ model: "universal-3-5-pro" }),
    llm: anthropic({ model: "claude-haiku-4-5" }),
    tts: cartesia({ voice: "v" }),
  };

  test("accepts all tuning fields in pipeline mode", () => {
    const m = parseManifest({
      name: "x",
      ...pipelineFields,
      minBargeInWords: 3,
      interruptionMinDurationMs: 500,
      holdPhrase: "Just a sec.",
      errorPhrase: "My brain went offline.",
      falseInterruptionTimeoutMs: 1500,
    } as never);
    expect(m.minBargeInWords).toBe(3);
    expect(m.interruptionMinDurationMs).toBe(500);
    expect(m.holdPhrase).toBe("Just a sec.");
    expect(m.errorPhrase).toBe("My brain went offline.");
    expect(m.falseInterruptionTimeoutMs).toBe(1500);
  });

  test("accepts the documented 'disable' values (0 timers, empty holdPhrase)", () => {
    const m = parseManifest({
      name: "x",
      ...pipelineFields,
      interruptionMinDurationMs: 0,
      holdPhrase: "",
      errorPhrase: "",
      falseInterruptionTimeoutMs: 0,
    } as never);
    expect(m.interruptionMinDurationMs).toBe(0);
    expect(m.holdPhrase).toBe("");
    expect(m.errorPhrase).toBe("");
    expect(m.falseInterruptionTimeoutMs).toBe(0);
  });

  test.each([
    ["minBargeInWords", 2],
    ["interruptionMinDurationMs", 500],
    ["holdPhrase", "One sec."],
    ["errorPhrase", "Something broke."],
    ["falseInterruptionTimeoutMs", 1500],
  ])("rejects %s in s2s mode", (field, value) => {
    expect(() => parseManifest({ name: "x", s2s: assemblyAIS2s(), [field]: value })).toThrow(
      new RegExp(`${field} requires pipeline mode`),
    );
  });

  test("rejects minBargeInWords below 1", () => {
    expect(() =>
      parseManifest({ name: "x", ...pipelineFields, minBargeInWords: 0 } as never),
    ).toThrow();
  });

  test("toAgentConfig propagates the tuning fields in pipeline mode", () => {
    const config = toAgentConfig({
      name: "x",
      systemPrompt: "p",
      greeting: "g",
      ...pipelineFields,
      minBargeInWords: 1,
      interruptionMinDurationMs: 400,
      holdPhrase: "",
      falseInterruptionTimeoutMs: 2500,
    });
    expect(config.minBargeInWords).toBe(1);
    expect(config.interruptionMinDurationMs).toBe(400);
    expect(config.holdPhrase).toBe("");
    expect(config.falseInterruptionTimeoutMs).toBe(2500);
  });

  test("toAgentConfig rejects tuning fields in s2s mode", () => {
    expect(() =>
      toAgentConfig({
        name: "x",
        systemPrompt: "p",
        greeting: "g",
        s2s: assemblyAIS2s(),
        minBargeInWords: 3,
      }),
    ).toThrow(/minBargeInWords requires pipeline mode/);
  });
});

describe("parseManifest s2s", () => {
  test("parseManifest accepts s2s descriptor", () => {
    const m = parseManifest({
      name: "x",
      s2s: { kind: "openai-realtime", options: { model: "gpt-realtime" } },
    });
    expect(m.s2s).toEqual({
      kind: "openai-realtime",
      options: { model: "gpt-realtime" },
    });
    expect(m.mode).toBe("s2s");
  });

  test("parseManifest rejects s2s combined with pipeline triple", () => {
    expect(() =>
      parseManifest({
        name: "x",
        s2s: { kind: "openai-realtime", options: {} },
        stt: { kind: "assemblyai", options: {} },
        llm: { kind: "openai", options: {} },
        tts: { kind: "cartesia", options: {} },
      }),
    ).toThrow(/s2s.*pipeline|cannot.*together/i);
  });
});

describe("assertProviderTriple with s2s", () => {
  test("returns 's2s' when s2s descriptor is set and pipeline triple is empty", () => {
    const s2s = { kind: "openai-realtime", options: {} };
    expect(assertProviderTriple(undefined, undefined, undefined, s2s)).toBe("s2s");
  });

  // Raw classifier only: the config layers inject the pipeline default
  // before calling this, so "nothing set" reaches it only for stored
  // configs predating the pipeline-by-default flip (wire tolerance).
  test("returns 's2s' when nothing is set (pre-flip wire tolerance)", () => {
    expect(assertProviderTriple(undefined, undefined, undefined, undefined)).toBe("s2s");
  });

  test("returns 'pipeline' when triple is set and s2s is not", () => {
    const stt = { kind: "x", options: {} };
    expect(assertProviderTriple(stt, stt, stt, undefined)).toBe("pipeline");
  });

  test("rejects setting s2s alongside any pipeline field", () => {
    const d = { kind: "x", options: {} };
    expect(() => assertProviderTriple(d, undefined, undefined, d)).toThrow(
      /s2s.*pipeline|cannot.*together/i,
    );
    expect(() => assertProviderTriple(undefined, d, undefined, d)).toThrow();
    expect(() => assertProviderTriple(undefined, undefined, d, d)).toThrow();
  });
});

describe("parseManifest — AssemblyAI TTS language validation", () => {
  test("rejects an unsupported AssemblyAI TTS language at parse time", () => {
    // The service refuses a bad `language` in-band, after the socket opens, so
    // without this the only signal is a mute session in production. Parse time
    // is what surfaces it to the CLI (aai dev/build/deploy) and to the
    // studio's test_agent, which reads the config the bundle entry builds.
    const fields = {
      stt: { kind: "assemblyai", options: {} },
      llm: { kind: "anthropic", options: { model: "m" } },
      tts: { kind: "assemblyai", options: { voice: "lola", language: "spanish" } },
    };
    expect(() => parseManifest({ name: "x", ...fields } as never)).toThrow(
      /unsupported language "spanish".*en, fr, de, it, pt, es/s,
    );
    expect(() =>
      toAgentConfig({ name: "x", systemPrompt: "p", greeting: "g", ...fields } as never),
    ).toThrow(/unsupported language "spanish"/);
  });

  test("accepts the six supported AssemblyAI TTS language codes", () => {
    for (const language of ["en", "fr", "de", "it", "pt", "es"]) {
      const m = parseManifest({
        name: "x",
        stt: { kind: "assemblyai", options: {} },
        llm: { kind: "anthropic", options: { model: "m" } },
        tts: { kind: "assemblyai", options: { language } },
      } as never);
      expect(m.tts?.options.language).toBe(language);
    }
  });
});
