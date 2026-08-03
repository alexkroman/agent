import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("simple template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run.
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("exports an agent with a name and no explicit providers", () => {
    // No provider fields declared: the default all-AssemblyAI pipeline is
    // injected at parse time (see `defaultProviders`).
    expect(agentDef.name).toBe("Simple Assistant");
    expect(agentDef.stt).toBeUndefined();
    expect(agentDef.s2s).toBeUndefined();
  });
});
