import { describe, expect, test } from "vitest";
import type { AgentConfig } from "./_internal_types.ts";
import { buildSystemPrompt } from "./session.ts";
import { DEFAULT_INSTRUCTIONS } from "./types.ts";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    instructions: DEFAULT_INSTRUCTIONS,
    greeting: "Hello",
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  test("starts with DEFAULT_INSTRUCTIONS when no custom instructions", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toMatch(
      new RegExp(`^${DEFAULT_INSTRUCTIONS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  });

  test("does not include agent-specific instructions section for default instructions", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("Agent-Specific Instructions:");
  });

  test("appends custom agent instructions", () => {
    const custom = "You are a pirate. Always speak like one.";
    const result = buildSystemPrompt(makeConfig({ instructions: custom }), { hasTools: false });
    expect(result).toContain("Agent-Specific Instructions:");
    expect(result).toContain(custom);
  });

  test("includes tool preamble when hasTools is true", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("ALWAYS say a brief natural phrase BEFORE the tool call");
  });

  test("omits tool preamble when hasTools is false", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("ALWAYS say a brief natural phrase BEFORE the tool call");
  });

  test("appends voice rules when voice is true", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, voice: true });
    expect(result).toContain("CRITICAL OUTPUT RULES");
    expect(result).toContain("NEVER use markdown");
  });

  test("omits voice rules when voice is false", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, voice: false });
    expect(result).not.toContain("CRITICAL OUTPUT RULES");
  });

  test("omits voice rules when voice is undefined", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("CRITICAL OUTPUT RULES");
  });

  test("includes today's date", () => {
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain(`Today's date is ${today}.`);
  });
});
