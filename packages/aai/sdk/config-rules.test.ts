// Copyright 2025 the AAI authors. MIT license.
// The shared config rules (mode classification, silence policy, pipeline
// tuning, TTS language) exercised through `toAgentConfig` — the one config
// entry point since `parseManifest` was removed. `createRuntime` and the
// server's IsolateConfigSchema run the same asserts.

import { describe, expect, test } from "vitest";
import { agentConfigWarnings, assertProviderTriple } from "./config-rules.ts";
import type { AgentConfig } from "./manifest-barrel.ts";
import { toAgentConfig } from "./manifest-barrel.ts";
import { assemblyAIPipeline } from "./providers/assemblyai-pipeline.ts";
import { anthropicLlm } from "./providers/llm/anthropic.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";
import { assemblyAIStt } from "./providers/stt/assemblyai.ts";
import { assemblyAITts } from "./providers/tts/assemblyai.ts";
import { cartesiaTts } from "./providers/tts/cartesia.ts";

const pipelineFields = {
  stt: assemblyAIStt({ model: "universal-3-5-pro" }),
  llm: anthropicLlm({ model: "claude-haiku-4-5" }),
  tts: cartesiaTts({ voice: "v" }),
};

/**
 * `toAgentConfig` over a RAW record — one seam for every "the type rejects this
 * shape, does the runtime accept/reject it too" case below, rather than a
 * laundering cast per assertion.
 *
 * `AgentConfigSource` deliberately forbids the shapes this file exercises (a
 * `system` alias, a string `llm`, `text: true`, a `mode` on a hand-written
 * `export default {...}`), because a TYPED caller must not write them — but the
 * function is documented to accept them from a raw object, and that behaviour
 * is what these tests cover. Narrowing once means adding a case costs no new
 * suppression.
 */
function rawConfig(fields: Record<string, unknown>): AgentConfig {
  return toAgentConfig(fields as never);
}

function config(fields: Record<string, unknown>): AgentConfig {
  return rawConfig({ name: "x", systemPrompt: "p", greeting: "g", ...fields });
}

describe("toAgentConfig — mode classification", () => {
  test("no providers ⇒ default AssemblyAI pipeline", () => {
    const parsed = config({});
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.stt).toEqual(assemblyAIPipeline().stt);
    expect(parsed.llm).toEqual(assemblyAIPipeline().llm);
    expect(parsed.tts).toEqual(assemblyAIPipeline().tts);
  });

  test("s2s descriptor (assemblyAIS2s) ⇒ mode: 's2s', no pipeline injection", () => {
    const parsed = config({ s2s: assemblyAIS2s() });
    expect(parsed.mode).toBe("s2s");
    expect(parsed.s2s).toEqual({ kind: "assemblyai", options: {} });
    expect(parsed.stt).toBeUndefined();
    expect(parsed.llm).toBeUndefined();
    expect(parsed.tts).toBeUndefined();
  });

  test("all three of stt/llm/tts set ⇒ mode: 'pipeline'", () => {
    const parsed = config(pipelineFields);
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.stt).toStrictEqual(pipelineFields.stt);
    expect(parsed.llm).toStrictEqual(pipelineFields.llm);
    expect(parsed.tts).toStrictEqual(pipelineFields.tts);
  });

  test("only stt set ⇒ pipeline, missing stages filled from the default", () => {
    const parsed = config({ stt: pipelineFields.stt });
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.stt).toStrictEqual(pipelineFields.stt);
    expect(parsed.llm).toEqual(assemblyAIPipeline().llm);
    expect(parsed.tts).toEqual(assemblyAIPipeline().tts);
  });

  test("stt + tts without llm ⇒ pipeline, llm filled from the default", () => {
    const parsed = config({ stt: pipelineFields.stt, tts: pipelineFields.tts });
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.stt).toStrictEqual(pipelineFields.stt);
    expect(parsed.tts).toStrictEqual(pipelineFields.tts);
    expect(parsed.llm).toEqual(assemblyAIPipeline().llm);
  });

  test("s2s + a pipeline stage ⇒ throws (never filled into S2S)", () => {
    expect(() => config({ s2s: assemblyAIS2s(), tts: pipelineFields.tts })).toThrow(
      /s2s and the stt\/llm\/tts pipeline cannot be set together/,
    );
  });

  test("voice shorthand ⇒ default pipeline with that TTS voice", () => {
    const parsed = config({ voice: "michael" });
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.tts).toEqual(assemblyAITts({ voice: "michael" }));
    expect(parsed.stt).toEqual(assemblyAIPipeline().stt);
    expect(parsed.llm).toEqual(assemblyAIPipeline().llm);
  });

  test("voice + explicit tts ⇒ throws (the descriptor owns its voice)", () => {
    expect(() => config({ voice: "michael", tts: pipelineFields.tts })).toThrow(
      /`voice` picks the default pipeline's TTS voice/,
    );
  });

  test("voice + s2s ⇒ throws (pipeline-mode only)", () => {
    expect(() => config({ voice: "michael", s2s: assemblyAIS2s() })).toThrow(
      /`voice` is pipeline-mode only/,
    );
  });

  test("accepts an s2s descriptor by raw shape", () => {
    const parsed = config({ s2s: { kind: "openai-realtime", options: { model: "gpt-realtime" } } });
    expect(parsed.s2s).toEqual({ kind: "openai-realtime", options: { model: "gpt-realtime" } });
    expect(parsed.mode).toBe("s2s");
  });

  test("rejects s2s combined with the pipeline triple", () => {
    expect(() =>
      config({ ...pipelineFields, s2s: { kind: "openai-realtime", options: {} } }),
    ).toThrow(/s2s.*pipeline|cannot.*together/i);
  });
});

describe("toAgentConfig — silence nudge", () => {
  test("accepts silenceTimeoutMs + silencePrompt in pipeline mode", () => {
    const parsed = config({
      ...pipelineFields,
      silenceTimeoutMs: 15_000,
      silencePrompt: "Ask if the user is still there.",
    });
    expect(parsed.silenceTimeoutMs).toBe(15_000);
    expect(parsed.silencePrompt).toBe("Ask if the user is still there.");
  });

  test("rejects silenceTimeoutMs in s2s mode", () => {
    expect(() => config({ s2s: assemblyAIS2s(), silenceTimeoutMs: 15_000 })).toThrow(
      /silenceTimeoutMs requires pipeline mode/,
    );
  });

  test("rejects silencePrompt without silenceTimeoutMs", () => {
    expect(() => config({ ...pipelineFields, silencePrompt: "Hello?" })).toThrow(
      /silencePrompt requires silenceTimeoutMs/,
    );
  });

  test("rejects non-positive silenceTimeoutMs", () => {
    // Named rather than bare: a bare `toThrow()` here passes on any throw the
    // shared `pipelineFields` fixture might start producing, so the guard could
    // be deleted and this test would stay green on unrelated validation.
    expect(() => config({ ...pipelineFields, silenceTimeoutMs: 0 })).toThrow(
      /silenceTimeoutMs[\s\S]*expected number to be >0/,
    );
  });
});

describe("agentConfigWarnings", () => {
  test("names a voice outside the catalog, since a typo is otherwise silent", () => {
    // Not an error: the catalog is the SERVICE's and a snapshot of it goes
    // stale, so refusing an unlisted voice would refuse one shipped last week.
    // Saying nothing leaves the common case — a typo — to surface as an agent
    // that connects, reports ready and never speaks.
    expect(agentConfigWarnings({ tts: assemblyAITts({ voice: "michal" }) })).toEqual([
      expect.stringContaining('AssemblyAI voice "michal" is not in this release\'s catalog'),
    ]);
  });

  test("says nothing about a voice the catalog lists", () => {
    expect(agentConfigWarnings({ tts: assemblyAITts({ voice: "michael" }) })).toEqual([]);
  });

  test("tells a DEPRECATED voice apart from an unknown one", () => {
    // It works today, so "unknown" would be wrong; it is going away, so
    // silence would be too.
    expect(agentConfigWarnings({ tts: assemblyAITts({ voice: "emma" }) })).toEqual([
      expect.stringContaining("scheduled for removal"),
    ]);
  });

  test("reads the S2S descriptor too, whose voice comes from the same catalog", () => {
    expect(agentConfigWarnings({ s2s: assemblyAIS2s({ voice: "michal" }) })).toEqual([
      expect.stringContaining('"michal"'),
    ]);
  });

  test("says nothing about another vendor's voice, which it cannot judge", () => {
    expect(agentConfigWarnings({ tts: cartesiaTts({ voice: "not-a-uuid" }) })).toEqual([]);
  });

  test("says nothing when no voice is declared", () => {
    expect(agentConfigWarnings({})).toEqual([]);
    expect(agentConfigWarnings({ tts: assemblyAITts() })).toEqual([]);
  });
});

describe("toAgentConfig — a shape mistake reads as a sentence", () => {
  test("a bad field is one line naming the field, not a dump of zod issues", () => {
    // This runs inside the generated bundle entry, so its throw is what an
    // author sees at `aai build`. A `ZodError`'s own message is the JSON of its
    // issue objects — twelve lines of `origin`/`code`/`path` for one wrong
    // number, and the only authoring error in this SDK that was not a sentence.
    let message = "";
    try {
      config({ ...pipelineFields, maxSteps: 0 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("This agent's configuration is invalid");
    expect(message).toContain("maxSteps");
    expect(message).not.toContain('"code"');
    expect(message.split("\n")).toHaveLength(1);
  });

  test("every bad field is named, not just the first", () => {
    expect(() => config({ ...pipelineFields, maxSteps: 0, minBargeInWords: 0 })).toThrow(
      /maxSteps[\s\S]*minBargeInWords/,
    );
  });

  test("rejects a blank name, which is a slug and a title with nothing in it", () => {
    expect(() => config({ ...pipelineFields, name: "   " })).toThrow(/name must not be blank/);
  });

  test("rejects a requiredEnv entry no environment could hold", () => {
    expect(() => config({ ...pipelineFields, requiredEnv: [""] })).toThrow(
      /requiredEnv holds VARIABLE NAMES/,
    );
    expect(() => config({ ...pipelineFields, requiredEnv: ["MY KEY"] })).toThrow(
      /requiredEnv holds VARIABLE NAMES/,
    );
  });

  test("leaves a duplicate requiredEnv entry alone — redundant, not unsatisfiable", () => {
    expect(config({ ...pipelineFields, requiredEnv: ["A", "A"] }).requiredEnv).toEqual(["A", "A"]);
  });
});

describe("toAgentConfig — pipeline voice tuning", () => {
  test("accepts all tuning fields in pipeline mode", () => {
    const parsed = config({
      ...pipelineFields,
      minBargeInWords: 3,
      interruptionMinDurationMs: 500,
      deadAirCoverMs: 2500,
      errorPhrase: "My brain went offline.",
      resumeFalseInterruption: false,
      preemptiveGeneration: true,
    });
    expect(parsed.preemptiveGeneration).toBe(true);
    expect(parsed.minBargeInWords).toBe(3);
    expect(parsed.interruptionMinDurationMs).toBe(500);
    expect(parsed.deadAirCoverMs).toBe(2500);
    expect(parsed.errorPhrase).toBe("My brain went offline.");
    expect(parsed.resumeFalseInterruption).toBe(false);
  });

  test("accepts the documented 'disable' values (0 timers, empty phrases)", () => {
    const parsed = config({
      ...pipelineFields,
      interruptionMinDurationMs: 0,
      deadAirCoverMs: 0,
      errorPhrase: "",
      resumeFalseInterruption: false,
    });
    expect(parsed.interruptionMinDurationMs).toBe(0);
    expect(parsed.deadAirCoverMs).toBe(0);
    expect(parsed.errorPhrase).toBe("");
    expect(parsed.resumeFalseInterruption).toBe(false);
  });

  test.each([
    ["minBargeInWords", 2],
    ["interruptionMinDurationMs", 500],
    ["deadAirCoverMs", 2500],
    ["errorPhrase", "Something broke."],
    ["resumeFalseInterruption", false],
    ["preemptiveGeneration", true],
  ])("rejects %s in s2s mode", (field, value) => {
    expect(() => config({ s2s: assemblyAIS2s(), [field]: value })).toThrow(
      new RegExp(`${field} requires pipeline mode`),
    );
  });

  test("rejects minBargeInWords below 1", () => {
    expect(() => config({ ...pipelineFields, minBargeInWords: 0 })).toThrow(
      /minBargeInWords[\s\S]*expected number to be >=1/,
    );
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
    // Every stage names the same rule. A bare `toThrow()` on the second and
    // third would also pass on the partial-triple error ("stt, llm, and tts
    // must be set together"), which is a different rule reached by a different
    // branch — and is exactly what a deleted s2s check would fall through to.
    const d = { kind: "x", options: {} };
    const together = /s2s and the stt\/llm\/tts pipeline cannot be set together/;
    expect(() => assertProviderTriple(d, undefined, undefined, d)).toThrow(together);
    expect(() => assertProviderTriple(undefined, d, undefined, d)).toThrow(together);
    expect(() => assertProviderTriple(undefined, undefined, d, d)).toThrow(together);
  });
});

describe("toAgentConfig — AssemblyAI TTS language validation", () => {
  test("rejects an unsupported AssemblyAI TTS language at config time", () => {
    // The service refuses a bad `language` in-band, after the socket opens, so
    // without this the only signal is a mute session in production. Config
    // time is what surfaces it to the CLI (aai dev/build/deploy) and to the
    // studio's test_agent, which reads the config the bundle entry builds.
    const fields = {
      stt: { kind: "assemblyai", options: {} },
      llm: { kind: "anthropic", options: { model: "m" } },
      tts: { kind: "assemblyai", options: { voice: "lola", language: "spanish" } },
    };
    expect(() => config(fields)).toThrow(/unsupported language "spanish".*en, fr, de, it, pt, es/s);
  });

  test.each(["en", "fr", "de", "it", "pt", "es"])(
    "accepts the supported AssemblyAI TTS language code %s",
    (language) => {
      const parsed = config({
        stt: { kind: "assemblyai", options: {} },
        llm: { kind: "anthropic", options: { model: "m" } },
        tts: { kind: "assemblyai", options: { language } },
      });
      expect(parsed.tts?.options.language).toBe(language);
    },
  );

  test("rejects a language the declared voice does not speak", () => {
    // Every catalog voice speaks exactly one language, and the service refuses
    // the pair in-band after the socket opens — the same mute session as an
    // unmapped code, reached from the other side.
    expect(() =>
      config({
        stt: { kind: "assemblyai", options: {} },
        llm: { kind: "anthropic", options: { model: "m" } },
        tts: { kind: "assemblyai", options: { voice: "estelle", language: "en" } },
      }),
    ).toThrow(/voice "estelle" speaks fr, not the declared language "en"/);
  });

  test("names the voices that DO speak the declared language", () => {
    expect(() =>
      config({
        stt: { kind: "assemblyai", options: {} },
        llm: { kind: "anthropic", options: { model: "m" } },
        tts: { kind: "assemblyai", options: { voice: "jane", language: "it" } },
      }),
    ).toThrow(/Voices that speak "it": giovanni/);
  });

  test("catches the mismatch the FACTORY used to manufacture", () => {
    // `assemblyAITts({ language })` fills in the default voice, which speaks
    // English — so asking for French and nothing else shipped a silent agent.
    expect(() =>
      config({
        stt: { kind: "assemblyai", options: {} },
        llm: { kind: "anthropic", options: { model: "m" } },
        tts: assemblyAITts({ language: "fr" }),
      }),
    ).toThrow(/Voices that speak "fr": estelle/);
  });

  test("passes through a voice the catalog does not list", () => {
    // The catalog is the SERVICE's and a snapshot of it goes stale between
    // releases, so a voice shipped after this one must still run — this check
    // only ever fires on a voice we know the language of.
    const parsed = config({
      stt: { kind: "assemblyai", options: {} },
      llm: { kind: "anthropic", options: { model: "m" } },
      tts: { kind: "assemblyai", options: { voice: "voice-shipped-last-week", language: "en" } },
    });
    expect(parsed.tts?.options.voice).toBe("voice-shipped-last-week");
  });

  test("a matching pair is left alone", () => {
    const parsed = config({
      stt: { kind: "assemblyai", options: {} },
      llm: { kind: "anthropic", options: { model: "m" } },
      tts: assemblyAITts({ voice: "lola", language: "es" }),
    });
    expect(parsed.tts?.options).toMatchObject({ voice: "lola", language: "es" });
  });
});

describe("author conveniences on raw configs (no agent())", () => {
  test("toAgentConfig reports `system` by name — it was an alias and is gone", () => {
    // A raw `export default {...}` is exactly where a stale `system` survives
    // an upgrade, because no `agent()` call type-checked it on the way in.
    expect(() => rawConfig({ name: "raw", system: "Be terse." })).toThrow(
      /`system` \(renamed to `systemPrompt`\)/,
    );
  });

  test("toAgentConfig desugars a string llm alongside a full triple", () => {
    const parsed = rawConfig({
      name: "raw",
      stt: assemblyAIStt(),
      llm: "anthropic/claude-sonnet-4-5",
      tts: { kind: "assemblyai", options: {} },
    });
    expect(parsed.llm?.kind).toBe("gateway");
  });

  test("keeps an explicit llm, which is the one stage it has", () => {
    const parsed = rawConfig({
      name: "chat",
      text: true,
      llm: "anthropic/claude-sonnet-4-5",
    });
    expect(parsed.mode).toBe("text");
    expect(parsed.llm?.kind).toBe("gateway");
    expect(parsed.stt).toBeUndefined();
  });

  test.each([
    ["stt", { stt: assemblyAIStt() }, /no audio path/],
    ["tts", { tts: { kind: "assemblyai", options: {} } }, /no audio path/],
    ["s2s", { s2s: { kind: "assemblyai", options: {} } }, /no speech stage/],
  ])("rejects text combined with %s", (_label, extra, message) => {
    expect(() => rawConfig({ name: "chat", text: true, ...extra })).toThrow(message);
  });

  test("rejects the pipeline-only tuning knobs, as s2s does", () => {
    expect(() => rawConfig({ name: "chat", text: true, deadAirCoverMs: 5000 })).toThrow(
      /deadAirCoverMs requires pipeline mode/,
    );
  });

  test("rejects the `voice` shorthand rather than fabricating a tts stage", () => {
    expect(() => rawConfig({ name: "chat", text: true, voice: "jane" })).toThrow(/never speaks/);
  });

  test("assertProviderTriple only answers `text` when asked about text", () => {
    // The overload says so at the type level; this pins the runtime half, so
    // the voice call sites' `Exclude<SessionMode, "text">` cannot become a lie.
    expect(assertProviderTriple(undefined, undefined, undefined, undefined)).toBe("s2s");
    expect(assertProviderTriple(undefined, {}, undefined, undefined, true)).toBe("text");
  });
});

describe("EU residency warning", () => {
  // `assemblyAIPipeline({ region: "eu" })` — the call in that function's own
  // @example — routes STT and the LLM gateway to the EU and TTS to the single
  // (US) endpoint. Documented in a JSDoc, which is the wrong strength of
  // statement for the one option here that is a compliance claim.
  test("warns when an EU stage sits beside a TTS stage that has no EU endpoint", () => {
    const warnings = agentConfigWarnings({
      stt: { kind: "assemblyai", options: { region: "eu" } },
      llm: { kind: "assemblyai", options: { region: "eu" } },
      tts: { kind: "assemblyai", options: {} },
    });
    expect(warnings.join("\n")).toContain("outside the EU");
    expect(warnings.join("\n")).toContain("streaming-tts.assemblyai.com");
  });

  test("says nothing for a US agent", () => {
    expect(
      agentConfigWarnings({
        stt: { kind: "assemblyai", options: {} },
        tts: { kind: "assemblyai", options: {} },
      }),
    ).toEqual([]);
  });

  test("says nothing when there is no TTS stage — nothing leaves the region", () => {
    expect(agentConfigWarnings({ stt: { kind: "assemblyai", options: { region: "eu" } } })).toEqual(
      [],
    );
  });

  test("an EU LLM alone is enough to warn — the stages are independent", () => {
    const warnings = agentConfigWarnings({
      llm: { kind: "assemblyai", options: { region: "eu" } },
      tts: { kind: "assemblyai", options: {} },
    });
    expect(warnings).toHaveLength(1);
  });
});

test("the warning fires on assemblyAIPipeline({ region: 'eu' }) itself", () => {
  // The call in `assemblyAIPipeline`'s own @example. Built through the real
  // preset rather than a hand-written descriptor, so a change to how the preset
  // threads `region` cannot pass this by accident.
  const warnings = agentConfigWarnings(assemblyAIPipeline({ region: "eu" }));
  expect(warnings.join("\n")).toContain("outside the EU");
});

describe("temperature scope", () => {
  // The main conversational loop took no sampling parameter at all, while
  // `ctx.generate` and `subagent()` both did — so the one model call that does
  // almost all the talking was the one an author could not tune.
  test("a pipeline agent may set it, and it reaches the config", () => {
    expect(rawConfig({ name: "Line", temperature: 0.2 }).temperature).toBe(0.2);
  });

  test("a text agent may set it — nothing about it is voice-specific", () => {
    expect(rawConfig({ name: "Docs", text: true, temperature: 0.9 }).temperature).toBe(0.9);
  });

  test("an S2S agent is REFUSED, rather than having it silently dropped", () => {
    expect(() => rawConfig({ name: "Line", s2s: assemblyAIS2s(), temperature: 0.2 })).toThrow(
      /no effect in s2s mode/,
    );
  });

  test("out of range is refused by the schema", () => {
    expect(() => rawConfig({ name: "Line", temperature: 5 })).toThrow(/configuration is invalid/);
  });

  test("unset stays unset — the model's own default applies", () => {
    expect(rawConfig({ name: "Line" }).temperature).toBeUndefined();
  });
});
