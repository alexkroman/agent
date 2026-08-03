import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("pipeline-simple template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run — catches an invalid
    // provider combination or tuning, not just descriptor presence.
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("declares only the LLM stage on the def", () => {
    // The template's point: swap one stage, leave the rest unset. The
    // unset stages are filled with the AssemblyAI defaults at parse time.
    expect(agentDef.name).toBe("pipeline-simple");
    expect(agentDef.llm).toBeDefined();
    expect(agentDef.stt).toBeUndefined();
    expect(agentDef.tts).toBeUndefined();
  });

  test("LLM descriptor is Anthropic", () => {
    expect(agentDef.llm?.kind).toBe("anthropic");
  });

  test("unset stages fill to AssemblyAI in the deployable config", () => {
    const config = toAgentConfig(agentDef);
    expect(config.mode).toBe("pipeline");
    expect(config.stt?.kind).toBe("assemblyai");
    expect(config.tts?.kind).toBe("assemblyai");
    expect(config.llm?.kind).toBe("anthropic");
  });
});
