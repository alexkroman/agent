// Copyright 2025 the AAI authors. MIT license.
/**
 * The invariant the SECTIONS carry, asserted on the sections themselves.
 *
 * `system-prompt.test.ts` next door asserts what `buildSystemPrompt` does with
 * them — which sections appear for which config, in what order, and under
 * which precedence header. What is left over, and what this file states, is
 * the property that holds before anything is assembled: every rule belongs to
 * exactly ONE section. That is not a restatement of the composition tests,
 * because the shape this module replaced composed correctly and still said the
 * same four rules twice.
 */

import { describe, expect, test } from "vitest";

import {
  PROMPT_LISTENING,
  PROMPT_PERSONALITY,
  PROMPT_ROLE,
  PROMPT_SPEAKING,
  PROMPT_TOOLS,
} from "./system-prompt-sections.ts";

const SECTIONS = {
  PROMPT_ROLE,
  PROMPT_PERSONALITY,
  PROMPT_SPEAKING,
  PROMPT_LISTENING,
  PROMPT_TOOLS,
} as const;

/** The sections a rule can land in, named, so a failure says WHERE it landed. */
const sectionsContaining = (marker: string): string[] =>
  Object.entries(SECTIONS)
    .filter(([, text]) => text.includes(marker))
    .map(([name]) => name);

describe("one rule, one section", () => {
  // The four rules the previous shape — a base prompt plus a `VOICE_RULES` and
  // a `TOOL_PREAMBLE` block bolted on at build time — stated TWICE each, in
  // wording that had already drifted apart. They are the regression this
  // module's split exists to prevent, so they are the ones pinned by name.
  test.each([
    ["the markdown ban", "No markdown", "PROMPT_SPEAKING"],
    ["the reply-length cap", "two sentences", "PROMPT_SPEAKING"],
    ["the eight-word opener", "eight words", "PROMPT_SPEAKING"],
    ["the spelled-input readback", "spelled input back", "PROMPT_LISTENING"],
  ])("%s is stated in %s's section only", (_label, marker, owner) => {
    expect(sectionsContaining(marker)).toEqual([owner]);
  });

  // The two rules that deliberately point in opposite directions — hyphenate
  // an identifier when SPEAKING it, copy it unchanged when SENDING it — and so
  // the pair most likely to be "helpfully" restated in the other's section,
  // where they would read as a contradiction rather than as two scopes.
  test("the spelling rule and the copy-exactly rule stay one section each", () => {
    expect(sectionsContaining("hyphenate it")).toEqual(["PROMPT_SPEAKING"]);
    expect(sectionsContaining("Copy values from prior tool results")).toEqual(["PROMPT_TOOLS"]);
  });
});

describe("section shape", () => {
  test.each([
    ["PROMPT_PERSONALITY", PROMPT_PERSONALITY, "## PERSONALITY"],
    ["PROMPT_SPEAKING", PROMPT_SPEAKING, "## SPEAKING"],
    ["PROMPT_LISTENING", PROMPT_LISTENING, "## LISTENING"],
    ["PROMPT_TOOLS", PROMPT_TOOLS, "## TOOLS"],
  ])("%s opens with its own heading", (_name, text, heading) => {
    expect(text.startsWith(`${heading}\n`)).toBe(true);
    // Once. A section that names its own heading twice is two sections.
    expect(text.split(heading)).toHaveLength(2);
  });

  // `PROMPT_ROLE` is the framing rather than a section, which is why it has no
  // heading and why it is always first.
  test("PROMPT_ROLE carries no heading", () => {
    expect(PROMPT_ROLE.startsWith("##")).toBe(false);
    expect(PROMPT_ROLE).not.toContain("\n##");
  });

  // The sections are joined with exactly `\n\n`, so a stray edge newline or a
  // trailing space changes the assembled prompt's bytes — and
  // `DEFAULT_SYSTEM_PROMPT`'s contract hash reads those bytes.
  test.each(Object.entries(SECTIONS))("%s is trimmed and non-empty", (_name, text) => {
    expect(text).toBe(text.trim());
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/[ \t]\n/);
  });

  test("no section is a copy of another", () => {
    const texts = Object.values(SECTIONS);
    expect(new Set(texts).size).toBe(texts.length);
  });
});
