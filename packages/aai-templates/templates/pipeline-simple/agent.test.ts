import { agent } from "@alexkroman1/aai";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { assemblyAIS2s, openAIS2s } from "@alexkroman1/aai/s2s";
import { assemblyAIStt, deepgramStt, elevenLabsStt, sonioxStt } from "@alexkroman1/aai/stt";
import { expectDeployable } from "@alexkroman1/aai/testing";
import { ASSEMBLYAI_TTS_VOICES, assemblyAITts, cartesiaTts, rimeTts } from "@alexkroman1/aai/tts";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("pipeline-simple template", () => {
  test("is deployable: validates, is nameable, and every stage its mode needs is filled", () => {
    // The three invariants every starter owes, thrown by name — the same
    // conversion `aai build`/`aai deploy` run, so an invalid provider
    // combination or tuning fails here rather than at the first live session.
    // The name is deliberately NOT the literal: `aai init <project>` scaffolds
    // this file verbatim, so a pinned name would be a test about the TEMPLATE
    // inside somebody else's project — and renaming the agent is the first
    // thing they will do. `not.toThrow()` because the helper's throw IS the
    // finding: vitest quotes the message, which names the invariant that went.
    expect(() => expectDeployable(agentDef)).not.toThrow();
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

  test("a stage you declare survives, and every stage you leave unset defaults to AssemblyAI", () => {
    // The template's whole subject, stated so it survives a swap: the config a
    // deploy carries agrees with the def wherever the def has an opinion, and
    // fills the AssemblyAI default wherever it does not. `expectDeployable`
    // already checks the first half (a declared stage survives as declared);
    // WHICH default fills the rest is this template's claim, so it is here.
    const config = expectDeployable(agentDef);
    if (config.mode !== "pipeline") {
      // Switched the def to `s2s`? Then there is no cascade to fill — S2S
      // REPLACES the pipeline rather than joining it, which `expectDeployable`
      // asserted and the last describe below is the worked example for.
      expect(config.mode).toBe("s2s");
      return;
    }
    for (const stage of ["stt", "llm", "tts"] as const) {
      expect(config[stage]?.kind, stage).toBe(agentDef[stage]?.kind ?? "assemblyai");
    }
  });

  test("a declared stage's TUNING survives too, not just its provider", () => {
    // The half `kind` cannot see, and the one a swap loses quietly: a
    // descriptor that arrives with its `options` dropped still reports the
    // right provider while running the gateway's default model — a different,
    // usually slower agent, with nothing on the line saying so. Read off the
    // def rather than pinned, because changing the model id is the first
    // tuning an author of this template tries. (This claim came from
    // `math-buddy`, which declared an LLM for the same reason and was removed
    // as a near-duplicate of `code-interpreter`; the stage swap lives here.)
    const config = expectDeployable(agentDef);
    const declared = (["stt", "llm", "tts"] as const).filter(
      (stage) => agentDef[stage] !== undefined,
    );
    // The loop below is a sweep over a FILTER, so it asserts nothing at all on
    // a def that declares no stage — the state the test above forbids, said
    // again here because a vacuous pass looks exactly like a passing one.
    expect(declared.length).toBeGreaterThan(0);
    for (const stage of declared) {
      expect(config[stage]?.options, stage).toEqual(agentDef[stage]?.options);
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
      [openAIS2s({ voice: "alloy" }), "openai-realtime"],
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
