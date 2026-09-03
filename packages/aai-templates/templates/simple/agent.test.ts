import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

/**
 * What a starter's spec may assert.
 *
 * Renaming the agent, giving it a voice, swapping a stage or switching the
 * whole thing to speech-to-speech are the first edits this template invites —
 * and `aai build` runs these tests before it bundles, so an assertion that
 * pins the template's own identity turns the first customization into a build
 * failure in a file the author never wrote. Every test here therefore asserts
 * a property that survives those edits, on the RESOLVED config rather than on
 * the def's empty fields.
 */
describe("simple template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run.
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("exports an agent the platform can name", () => {
    // Not the literal: what has to hold is that there IS a name, and that the
    // conversion carries it through — `AgentName` refuses a blank one, and the
    // studio lists a deployed agent by exactly this string.
    expect(agentDef.name).toBeTruthy();
    expect(toAgentConfig(agentDef).name).toBe(agentDef.name);
  });

  test("every stage its mode needs is filled, declared or defaulted", () => {
    // The template's point: with no provider fields declared, the default
    // all-AssemblyAI cascaded pipeline is injected at parse time (see
    // `defaultProviders`) — so an agent that declares nothing still runs.
    // Asserted per MODE so it stays true after a swap: declare `stt`/`llm`/`tts`
    // and the rest still default; declare `s2s` and there is no cascade to fill,
    // which is the one thing that must never happen by fallthrough.
    const config = toAgentConfig(agentDef);
    if (config.mode === "s2s") {
      expect(config.s2s?.kind).toBeTruthy();
      expect(config.stt).toBeUndefined();
      expect(config.tts).toBeUndefined();
    } else if (config.mode === "text") {
      expect(config.llm?.kind).toBeTruthy();
    } else {
      expect(config.mode).toBe("pipeline");
      expect(config.stt?.kind).toBeTruthy();
      expect(config.llm?.kind).toBeTruthy();
      expect(config.tts?.kind).toBeTruthy();
    }
  });
});
