import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("pipeline-simple template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run — catches a partial
    // provider triple or invalid tuning, not just descriptor presence.
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("exports an agent with all three pipeline providers", () => {
    // Presence of stt + llm + tts is what flips the runtime into
    // pipeline mode (see parseManifest). Smoke-test each is wired up.
    expect(agentDef.name).toBe("pipeline-simple");
    expect(agentDef.stt).toBeDefined();
    expect(agentDef.llm).toBeDefined();
    expect(agentDef.tts).toBeDefined();
  });

  test("STT descriptor is AssemblyAI", () => {
    expect(agentDef.stt?.kind).toBe("assemblyai");
  });

  test("LLM descriptor is Anthropic", () => {
    expect(agentDef.llm?.kind).toBe("anthropic");
  });

  test("TTS descriptor is AssemblyAI", () => {
    expect(agentDef.tts?.kind).toBe("assemblyai");
  });
});
