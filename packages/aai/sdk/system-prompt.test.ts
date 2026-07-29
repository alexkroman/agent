// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeConfig } from "../host/_test-utils.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./types.ts";

describe("buildSystemPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  test("voice rules tell the agent not to read spelled input back letter by letter", () => {
    // Verbose letter-by-letter readbacks make replies long and invite the
    // caller to interrupt mid-sentence (see tau2 turn-taking analysis).
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, voice: true });
    expect(result).toContain("do NOT read the whole thing back letter by letter");
  });

  test("omits voice rules when voice is false", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, voice: false });
    expect(result).not.toContain("CRITICAL OUTPUT RULES");
  });

  test("omits voice rules when voice is undefined", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("CRITICAL OUTPUT RULES");
  });

  test("includes correctly formatted date string", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("Today's date is Wednesday, January 15, 2025.");
  });

  test("date format uses en-US locale with weekday, month, day, and year", () => {
    // Advance to a different date to verify format consistency
    vi.setSystemTime(new Date("2025-12-31T12:00:00Z"));
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("Today's date is Wednesday, December 31, 2025.");
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

  test("sections appear in correct order", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      voice: true,
    });
    const dateIdx = result.indexOf("Today's date is");
    const instructionsIdx = result.indexOf("Agent-Specific Instructions:");
    const toolIdx = result.indexOf("ALWAYS say a brief natural phrase");
    const voiceIdx = result.indexOf("CRITICAL OUTPUT RULES");

    expect(dateIdx).toBeGreaterThan(0);
    expect(instructionsIdx).toBeGreaterThan(dateIdx);
    expect(toolIdx).toBeGreaterThan(instructionsIdx);
    expect(voiceIdx).toBeGreaterThan(toolIdx);
  });

  test("empty custom instructions treated same as default", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "" }), { hasTools: false });
    expect(result).not.toContain("Agent-Specific Instructions:");
  });

  test("toolGuidance: [] omits the Built-in Tool Usage section", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, toolGuidance: [] });
    expect(result).not.toContain("Built-in Tool Usage:");
  });

  test("toolGuidance lines are joined with newlines under one header", () => {
    const result = buildSystemPrompt(makeConfig(), {
      hasTools: false,
      toolGuidance: ["- Use think before answering.", "- Use recall to look things up."],
    });
    expect(result).toContain(
      "\n\nBuilt-in Tool Usage:\n- Use think before answering.\n- Use recall to look things up.",
    );
  });

  // Exact-equality assertions: the prompt text is behavior (it steers the
  // LLM), so pin every assembled byte rather than spot-checking fragments.
  test("minimal prompt is exactly the default plus the date", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toBe(`${DEFAULT_SYSTEM_PROMPT}\n\nToday's date is Wednesday, January 15, 2025.`);
  });

  test("full prompt assembles every section verbatim", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      voice: true,
      toolGuidance: ["- Guidance line."],
    });
    const toolPreamble =
      "\n\nWhen you decide to use a tool, ALWAYS say a brief natural phrase BEFORE the tool call " +
      '(e.g. "Let me look that up" or "One moment while I check"). ' +
      "This fills silence while the tool executes. Keep preambles to one short sentence.";
    const voiceRules =
      "\n\nCRITICAL OUTPUT RULES — you MUST follow these for EVERY response:\n" +
      "Your response will be spoken aloud by a TTS system and displayed as plain text.\n" +
      "- NEVER use markdown: no **, no *, no _, no #, no `, no [](), no ---\n" +
      "- NEVER use bullet points (-, *, •) or numbered lists (1., 2.)\n" +
      "- NEVER use code blocks or inline code\n" +
      "- NEVER mention tools, search, APIs, or technical failures to the user. " +
      "If a tool returns no results, just answer naturally without explaining why.\n" +
      "- Write exactly as you would say it out loud to a friend\n" +
      '- Use short conversational sentences. To list things, say "First," "Next," "Finally,"\n' +
      "- Keep responses concise — 1 to 3 sentences max\n" +
      "- When the caller spells something (a name, email, or ID) or reads out digits, do NOT " +
      "read the whole thing back letter by letter — it is slow and invites interruptions. " +
      'Confirm briefly and move on (e.g. "Thanks, got it" or "Okay, Yusuf Rossi, ZIP 1-9-1-2-2 — one moment"). ' +
      "Only re-spell a specific character if you need to resolve a genuine ambiguity.";
    expect(result).toBe(
      DEFAULT_SYSTEM_PROMPT +
        "\n\nToday's date is Wednesday, January 15, 2025." +
        "\n\nAgent-Specific Instructions:\nCustom rules." +
        toolPreamble +
        "\n\nBuilt-in Tool Usage:\n- Guidance line." +
        voiceRules,
    );
  });
});
