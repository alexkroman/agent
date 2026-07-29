import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("sync-voice template", () => {
  test("config passes manifest validation", () => {
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("exports a pipeline agent (sync turns require the provider triple)", () => {
    expect(agentDef.name).toBe("sync-voice");
    expect(agentDef.stt).toBeDefined();
    expect(agentDef.llm).toBeDefined();
    expect(agentDef.tts).toBeDefined();
  });

  test("providers carry the one-shot capabilities sync mode uses", () => {
    // AssemblyAI is the STT provider with a batch (Sync API) endpoint —
    // audio turns 422 without one.
    expect(agentDef.stt?.kind).toBe("assemblyai");
    // Cartesia is the TTS provider with one-shot synthesis (/tts/bytes) —
    // any other kind would answer text-only.
    expect(agentDef.tts?.kind).toBe("cartesia");
  });
});
