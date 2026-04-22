import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("pipeline-simple template", () => {
  test("exports an agent with all three pipeline providers", () => {
    // Presence of stt + llm + tts is what flips the runtime into
    // pipeline mode (see parseManifest). Smoke-test each is wired up.
    expect(agentDef.name).toBe("pipeline-simple");
    expect(agentDef.stt).toBeDefined();
    expect(agentDef.llm).toBeDefined();
    expect(agentDef.tts).toBeDefined();
  });

  test("STT provider is AssemblyAI", () => {
    expect(agentDef.stt.name).toBe("assemblyai");
  });

  test("TTS provider is Cartesia", () => {
    expect(agentDef.tts.name).toBe("cartesia");
  });
});
