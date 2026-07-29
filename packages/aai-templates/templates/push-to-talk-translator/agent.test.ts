import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("push-to-talk-translator template", () => {
  test("config passes manifest validation", () => {
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("exports a pipeline agent (sync turns require the provider triple)", () => {
    expect(agentDef.name).toBe("push-to-talk-translator");
    expect(agentDef.stt).toBeDefined();
    expect(agentDef.llm).toBeDefined();
    expect(agentDef.tts).toBeDefined();
  });

  test("providers carry the one-shot capabilities sync mode uses", () => {
    // Batch STT (AssemblyAI Sync API) transcribes the held-button clip;
    // one-shot TTS (Cartesia /tts/bytes) speaks the translation back.
    expect(agentDef.stt?.kind).toBe("assemblyai");
    expect(agentDef.tts?.kind).toBe("cartesia");
  });

  test("systemPrompt makes the reply the translation and nothing else", () => {
    expect(agentDef.systemPrompt).toContain("Translate");
    expect(agentDef.systemPrompt).toContain("ONLY the translation");
  });
});
