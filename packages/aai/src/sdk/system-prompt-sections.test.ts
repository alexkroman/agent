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
    ["the spelled-value readback", "Read a spelled value back", "PROMPT_LISTENING"],
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

  // The policy rules ported from the tau2-bench prompt studies (see the
  // PROMPT_TOOLS doc). Each overlapped a rule already here, so each was merged
  // into the bullet that owned it rather than stated again.
  test.each([
    ["checking the record over the claim", "Check the record, not the claim."],
    ["a write is not an approval", "A tool that accepts a write has not approved it."],
    ["only what was asked", "don't add it and don't offer it"],
    ["one confirmation per request", 'one confirmation that opens "Nothing\'s changed yet."'],
    ["every write the yes covered", "make every write it covered back to back"],
    ["a description is a search", "A described choice is a search."],
    [
      "finishing the allowed part of a blocked request",
      "Every allowed change comes BEFORE any transfer",
    ],
  ])("the policy rule on %s lives in TOOLS only", (_label, marker) => {
    expect(sectionsContaining(marker)).toEqual(["PROMPT_TOOLS"]);
  });

  // The confirmation runs past SPEAKING's cap on purpose. TOOLS states the
  // exemption: a tool-less agent gets no TOOLS section, so a pointer to it from
  // SPEAKING would name a section that prompt does not have.
  test("the confirmation's exemption from SPEAKING lives in TOOLS", () => {
    expect(PROMPT_SPEAKING).not.toContain("TOOLS");
    expect(PROMPT_TOOLS).toContain("may run past SPEAKING's two-sentence limit");
    expect(PROMPT_TOOLS).toContain("its opening is not a preface");
    expect(sectionsContaining("Nothing's changed yet")).toEqual(["PROMPT_TOOLS"]);
  });

  // Asked ONCE: a second confirmation before the writes is the round trip the
  // rule exists to remove, so it must not come back as a separate bullet.
  test("there is one confirmation bullet, not one per change", () => {
    expect(PROMPT_TOOLS.split("Before an action that's hard to undo")).toHaveLength(2);
    expect(PROMPT_TOOLS).toContain("Never ask for the same confirmation twice.");
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
