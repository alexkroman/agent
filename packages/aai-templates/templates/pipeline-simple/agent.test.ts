import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("pipeline-simple template", () => {
  test("exports an agent with all three pipeline providers", () => {
    // Presence of stt + llm + tts is what flips the runtime into
    // pipeline mode (see parseManifest). Smoke-test each is wired up
    // with the expected provider (a defined kind also proves presence).
    expect(agentDef.name).toBe("pipeline-simple");
    expect(agentDef.stt?.kind).toBe("assemblyai");
    expect(agentDef.llm?.kind).toBe("anthropic");
    expect(agentDef.tts?.kind).toBe("cartesia");
  });
});
