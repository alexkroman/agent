import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("pipeline-text-only template", () => {
  test("exports an agent with the full pipeline triple", () => {
    // tts: none() still counts toward the all-or-none stt/llm/tts rule —
    // that's what keeps a *forgotten* tts a loud config error.
    expect(agentDef.name).toBe("pipeline-text-only");
    expect(agentDef.stt).toBeDefined();
    expect(agentDef.llm).toBeDefined();
    expect(agentDef.tts).toBeDefined();
  });

  test("TTS descriptor is the text-only sentinel", () => {
    expect(agentDef.tts?.kind).toBe("none");
    expect(agentDef.tts?.options).toEqual({});
  });

  test("STT and LLM are real providers", () => {
    expect(agentDef.stt?.kind).toBe("assemblyai");
    expect(agentDef.llm?.kind).toBe("anthropic");
  });
});
