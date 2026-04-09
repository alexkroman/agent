import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../isolate/system-prompt.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../isolate/types.ts";
import { makeConfig } from "./_test-utils.ts";

describe("buildSystemPrompt", () => {
  test("starts with DEFAULT_SYSTEM_PROMPT when no custom instructions", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
  });

  test("does not include agent-specific instructions section for default instructions", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("Agent-Specific Instructions:");
  });

  test("appends custom agent instructions", () => {
    const custom = "You are a pirate. Always speak like one.";
    const result = buildSystemPrompt(makeConfig({ systemPrompt: custom }), { hasTools: false });
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

  test("voice + hasTools includes both voice rules and tool preamble", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true, voice: true });
    expect(result).toContain("CRITICAL OUTPUT RULES");
    expect(result).toContain("ALWAYS say a brief natural phrase BEFORE the tool call");
  });

  test("custom instructions + voice + tools includes all sections", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Be concise." }), {
      hasTools: true,
      voice: true,
    });
    expect(result).toContain("Agent-Specific Instructions:");
    expect(result).toContain("Be concise.");
    expect(result).toContain("CRITICAL OUTPUT RULES");
    expect(result).toContain("ALWAYS say a brief natural phrase BEFORE the tool call");
  });
});
