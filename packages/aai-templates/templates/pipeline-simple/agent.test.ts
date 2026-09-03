import { agent } from "@alexkroman1/aai";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { assemblyAIS2s, openaiS2s } from "@alexkroman1/aai/s2s";
import { assemblyAIStt, deepgramStt, elevenLabsStt, sonioxStt } from "@alexkroman1/aai/stt";
import { ASSEMBLYAI_TTS_VOICES, assemblyAITts, cartesiaTts, rimeTts } from "@alexkroman1/aai/tts";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("pipeline-simple template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run — catches an invalid
    // provider combination or tuning, not just descriptor presence.
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("exports an agent the platform can name", () => {
    // Not the literal. `aai init <project>` scaffolds this file verbatim, so a
    // pinned name is a test about the TEMPLATE inside somebody else's project —
    // and renaming the agent is the first thing they will do. What has to hold
    // is that there is a name and the conversion carries it through.
    expect(agentDef.name).toBeTruthy();
    expect(toAgentConfig(agentDef).name).toBe(agentDef.name);
  });

  test("declares at least one stage itself, which is what makes it a pipeline", () => {
    // WHICH stage is deliberately not asserted: `agent.ts` invites you to move
    // the declaration ("Declare only the stage you want elsewhere"), so naming
    // one here would redden on the edit the comment above it asks for.
    const declared = (["stt", "llm", "tts"] as const).filter(
      (stage) => agentDef[stage] !== undefined,
    );
    expect(declared.length).toBeGreaterThan(0);
  });

  test("a stage you declare survives, and every stage you leave unset defaults", () => {
    // The template's whole subject, stated so it survives a swap: the config a
    // deploy carries agrees with the def wherever the def has an opinion, and
    // fills the AssemblyAI default wherever it does not.
    const config = toAgentConfig(agentDef);
    if (config.mode !== "pipeline") {
      // Switched the def to `s2s`? Then there is no cascade to fill — S2S
      // REPLACES the pipeline rather than joining it, which the last describe
      // below is the worked example for.
      expect(config.mode).toBe("s2s");
      expect(config.stt).toBeUndefined();
      expect(config.tts).toBeUndefined();
      return;
    }
    for (const stage of ["stt", "llm", "tts"] as const) {
      expect(config[stage]?.kind, stage).toBe(agentDef[stage]?.kind ?? "assemblyai");
    }
  });
});

/**
 * The other stage swaps, as worked examples.
 *
 * `agent.ts` above declares one — the LLM — because an agent should declare one
 * thing. But the rest of the provider surface had NO example anywhere: zero of
 * the 26 templates set `stt:`, `tts:` or `s2s:`, so `@alexkroman1/aai/stt` and
 * `/s2s` were 100% unexercised while carrying a semver promise. That is either
 * an API nobody needs or an API nobody has run, and neither is a good place to
 * leave a published surface.
 *
 * They live in the spec rather than in `agent.ts` for a reason worth copying:
 * a deployed agent needs a key per vendor it names, and the all-AssemblyAI
 * default is what makes the starter run the moment it is deployed. Declaring a
 * stage here shows the shape and costs the template nothing.
 */
describe("swapping any other stage", () => {
  test("STT: four providers, each one field on `agent()`", () => {
    for (const [stt, kind] of [
      [assemblyAIStt({ region: "eu" }), "assemblyai"],
      [deepgramStt({ language: "en" }), "deepgram"],
      [elevenLabsStt(), "elevenlabs"],
      [sonioxStt({ languages: ["en", "es"] }), "soniox"],
    ] as const) {
      const config = toAgentConfig(agent({ name: "Line", stt }));
      expect(config.stt?.kind).toBe(kind);
      // Whatever the STT stage is, the two it does not touch still default.
      expect(config.llm?.kind).toBe("assemblyai");
      expect(config.tts?.kind).toBe("assemblyai");
    }
  });

  test("TTS: three providers, and the AssemblyAI voice catalog is typed", () => {
    for (const [tts, kind] of [
      [assemblyAITts({ voice: "jane" }), "assemblyai"],
      [cartesiaTts(), "cartesia"],
      [rimeTts(), "rime"],
    ] as const) {
      expect(toAgentConfig(agent({ name: "Line", tts })).tts?.kind).toBe(kind);
    }
    // A voice outside the catalog still compiles — it may be one shipped after
    // this release — and `agentConfigWarnings` is what says so. See its doc.
    expect(Object.keys(ASSEMBLYAI_TTS_VOICES).length).toBeGreaterThan(0);
  });

  test("S2S: an explicit opt-in, and it REPLACES the pipeline rather than joining it", () => {
    for (const [s2s, kind] of [
      [assemblyAIS2s(), "assemblyai"],
      [openaiS2s({ voice: "alloy" }), "openai-realtime"],
    ] as const) {
      const config = toAgentConfig(agent({ name: "Line", s2s }));
      expect(config.s2s?.kind).toBe(kind);
      expect(config.mode).toBe("s2s");
      // No cascade is filled in: speech-to-speech has no separate STT or TTS,
      // which is the whole difference and the reason `s2s` is never a default.
      expect(config.stt).toBeUndefined();
      expect(config.tts).toBeUndefined();
    }
  });

  test("mixing S2S with a pipeline stage is refused, by the type AND by the config", () => {
    // The type refuses it outright: `agent({ s2s, tts })` does not compile, which
    // is why this reaches the runtime rule by spreading instead. Both halves
    // matter — the second is what catches a raw `export default {...}` that
    // never went through `agent()`.
    const s2sAgent = agent({ name: "Line", s2s: assemblyAIS2s() });
    expect(() => toAgentConfig({ ...s2sAgent, tts: cartesiaTts() })).toThrow();
  });
});
