// Copyright 2026 the AAI authors. MIT license.
/**
 * The default prompts are DATA, so what is asserted is the contract each one
 * carries with the code around it: the tool name the researcher is told to
 * call, the field names the JSON stages are parsed by, and the numbering the
 * report stage is handed.
 */

import { describe, expect, test } from "vitest";
import { DEFAULT_DEEP_RESEARCH_PROMPTS } from "./deep-research-prompts.ts";

describe("DEFAULT_DEEP_RESEARCH_PROMPTS", () => {
  test("every stage has a prompt", () => {
    for (const [stage, prompt] of Object.entries(DEFAULT_DEEP_RESEARCH_PROMPTS)) {
      expect(prompt.trim().length, stage).toBeGreaterThan(0);
    }
  });

  test("the researcher is told to call the tool the pass actually adds", () => {
    expect(DEFAULT_DEEP_RESEARCH_PROMPTS.research).toContain("`cite`");
  });

  test("the JSON stages name the fields their reply is parsed by", () => {
    expect(DEFAULT_DEEP_RESEARCH_PROMPTS.brief).toContain("`brief`");
    expect(DEFAULT_DEEP_RESEARCH_PROMPTS.brief).toContain("`criteria`");
    expect(DEFAULT_DEEP_RESEARCH_PROMPTS.plan).toContain("`angles`");
    expect(DEFAULT_DEEP_RESEARCH_PROMPTS.gaps).toContain("`angles`");
  });

  test("the report cites by the numbers it is given, and the summary carries none", () => {
    expect(DEFAULT_DEEP_RESEARCH_PROMPTS.report).toMatch(/numbers in the Sources list/);
    expect(DEFAULT_DEEP_RESEARCH_PROMPTS.summary).toMatch(/no citation markers/i);
  });
});
