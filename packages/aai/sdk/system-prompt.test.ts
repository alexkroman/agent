// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeConfig } from "../host/_test-utils.ts";
import {
  buildSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  PROMPT_LISTENING,
  PROMPT_PERSONALITY,
  PROMPT_ROLE,
  PROMPT_SPEAKING,
  PROMPT_TOOLS,
} from "./system-prompt.ts";

const VOICE_CORE = [PROMPT_ROLE, PROMPT_PERSONALITY, PROMPT_SPEAKING, PROMPT_LISTENING].join(
  "\n\n",
);
const DATE_LINE = "Today's date is Wednesday, January 15, 2025.";
const AGENT_HEADER =
  "Agent-specific instructions (these override the defaults above where they conflict):";

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("buildSystemPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("always opens with the voice core", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result.startsWith(VOICE_CORE)).toBe(true);
  });

  test("does not include agent-specific instructions section for default instructions", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain(AGENT_HEADER);
  });

  test("appends custom agent instructions", () => {
    const custom = "You are a pirate. Always speak like one.";
    const result = buildSystemPrompt(makeConfig({ systemPrompt: custom }), { hasTools: false });
    expect(result).toContain(AGENT_HEADER);
    expect(result).toContain(custom);
  });

  // Position has to agree with the precedence PROMPT_ROLE states. When the
  // agent's own instructions sat mid-prompt with defaults after them, the
  // prompt told the model the later text loses.
  test("agent instructions come last, after every default section", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      toolGuidance: ["- Guidance line."],
    });
    expect(result.endsWith(`${AGENT_HEADER}\nCustom rules.`)).toBe(true);
  });

  test("includes the TOOLS section when hasTools is true", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain(PROMPT_TOOLS);
  });

  test("omits the TOOLS section when hasTools is false", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("## TOOLS");
  });

  // Measured against tau2-bench retail: 42/815 replies stacked two or more
  // preambles and 12 stacked three or more, because the old wording ("ALWAYS
  // say a brief natural phrase BEFORE the tool call") scopes per CALL and
  // `maxSteps` allows ten of them in one turn. The caller then hears a
  // play-by-play of the tool loop. These pin the scoping, not the phrasing.
  test("scopes the holding line to once per TURN, not once per tool call", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("PER TURN, not once per tool call");
    expect(result).toContain("stay silent between calls");
  });

  test("tells the model a not-found lookup may be a mis-hearing", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("a mis-hearing is the most\n  likely cause");
    // The re-ask must vary: repeating the request replays the same audio and
    // yields the same mis-transcription.
    expect(result).toContain("ask for something DIFFERENT");
  });

  // The dominant failure across all three voice benchmarks: the agent says
  // "your window seat is reserved" having never called assign_seat, so the
  // final DB has seat=null. EVA scored faithfulness 0.075 on this alone.
  test("TOOLS forbids claiming an action without a successful tool result", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("Never say an action is done");
    expect(result).toContain("Carrying something over");
  });

  test("the claim-an-action rule is tool-gated", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("Never say an action is done");
  });

  // Delivery rules are unconditional: every session this builder serves
  // speaks, so gating them behind `voice` only ever produced a prompt that
  // told a speaking agent it could emit markdown.
  // `voice` is reserved rather than honoured, so it is passed by omission as
  // well as explicitly — `exactOptionalPropertyTypes` makes those two
  // genuinely different calls.
  test.each([
    ["voice: true", { hasTools: false, voice: true }],
    ["voice: false", { hasTools: false, voice: false }],
    ["voice omitted", { hasTools: false }],
  ])("delivery rules are present with %s", (_label, opts) => {
    const result = buildSystemPrompt(makeConfig(), opts);
    expect(result).toContain("Keep the whole reply to two sentences");
    expect(result).toContain("No markdown, bullet");
    expect(result).toContain("FIRST sentence is at most eight words");
  });

  // 30% of all synthesized agent audio in the tau2 run was discarded by
  // barge-in — the caller interrupts partway through an enumerated list and
  // never hears the rest.
  test("SPEAKING forbids reading long results out item by item", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("Never read out a long\n  list");
  });

  // Spoken "K dash 2" reached add_to_cart as "K-2" (expected "K2"), and a
  // spelled confirmation code "Z K 3 F F W" arrived as "ZEDK3FFW" — the
  // single most common tool error in tau2 was "User not found". These are
  // transcript-reading rules, so they live in LISTENING and apply even to a
  // tool-less agent that only has to repeat an identifier back.
  test("LISTENING writes spoken identifiers in written form, with or without tools", () => {
    for (const hasTools of [true, false]) {
      const result = buildSystemPrompt(makeConfig(), { hasTools });
      expect(result).toContain('"K dash 2" is K2');
      expect(result).toContain("ZK3FFW, never ZEDK3FFW");
      expect(result).toContain("ordinary title case");
    }
  });

  // Verbose letter-by-letter readbacks make replies long and invite the
  // caller to interrupt mid-sentence (see tau2 turn-taking analysis).
  test("LISTENING forbids reading spelled input back letter by letter", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("Don't read spelled input back letter by letter");
  });

  test("includes correctly formatted date string", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain(DATE_LINE);
  });

  test("date format uses en-US locale with weekday, month, day, and year", () => {
    // Advance to a different date to verify format consistency
    vi.setSystemTime(new Date("2025-12-31T12:00:00Z"));
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("Today's date is Wednesday, December 31, 2025.");
  });

  test("sections appear in correct order", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      toolGuidance: ["- Guidance line."],
    });
    const indices = [
      result.indexOf("## PERSONALITY"),
      result.indexOf("## SPEAKING"),
      result.indexOf("## LISTENING"),
      result.indexOf("## TOOLS"),
      result.indexOf("Today's date is"),
      result.indexOf("Built-in tool usage:"),
      result.indexOf(AGENT_HEADER),
    ];
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices.every((i) => i > 0)).toBe(true);
  });

  // The invariant the section split exists to hold: one rule, one place. The
  // old base-prompt-plus-appended-blocks shape stated each of these twice, in
  // wording that had drifted apart — the base prompt allowed a filler opener
  // the voice rules banned, and capped the reply at "one or two sentences"
  // against the voice rules' two.
  test("no rule is stated twice in the assembled prompt", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      voice: true,
      toolGuidance: ["- Guidance line."],
    });
    for (const phrase of [
      "No markdown, bullet",
      "FIRST sentence is at most eight words",
      "Keep the whole reply to two sentences",
      "letter by letter",
      "Today's date is",
      "## SPEAKING",
      "## TOOLS",
    ]) {
      expect(countOf(result, phrase), `"${phrase}" should appear exactly once`).toBe(1);
    }
  });

  test("empty custom instructions treated same as default", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "" }), { hasTools: false });
    expect(result).not.toContain(AGENT_HEADER);
  });

  test("toolGuidance: [] omits the built-in tool usage section", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, toolGuidance: [] });
    expect(result).not.toContain("Built-in tool usage:");
  });

  test("toolGuidance lines are joined with newlines under one header", () => {
    const result = buildSystemPrompt(makeConfig(), {
      hasTools: false,
      toolGuidance: ["- Use think before answering.", "- Use recall to look things up."],
    });
    expect(result).toContain(
      "\n\nBuilt-in tool usage:\n- Use think before answering.\n- Use recall to look things up.",
    );
  });

  // Exact-equality assertions: the prompt text is behavior (it steers the
  // LLM), so pin every assembled byte. Composed from the section constants
  // rather than re-typed prose — what this builder owns is the ORDER and the
  // separators, and a re-typed copy only ever pins the copy.
  test("minimal prompt is exactly the voice core plus the date", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toBe(`${VOICE_CORE}\n\n${DATE_LINE}`);
  });

  test("full prompt assembles every section verbatim", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      voice: true,
      toolGuidance: ["- Guidance line."],
    });
    expect(result).toBe(
      [
        PROMPT_ROLE,
        PROMPT_PERSONALITY,
        PROMPT_SPEAKING,
        PROMPT_LISTENING,
        PROMPT_TOOLS,
        DATE_LINE,
        "Built-in tool usage:\n- Guidance line.",
        `${AGENT_HEADER}\nCustom rules.`,
      ].join("\n\n"),
    );
  });

  test("DEFAULT_SYSTEM_PROMPT is the full default: voice core plus tools", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toBe(`${VOICE_CORE}\n\n${PROMPT_TOOLS}`);
  });
});
