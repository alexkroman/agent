// Copyright 2026 the AAI authors. MIT license.
/**
 * The two sentences said about a prompt carrying its own copy of the default.
 *
 * `system-prompt.test.ts` asserts that assembly REACHES this module; these are
 * the sentences themselves and the once-per-prompt rule, which is keyed by text
 * rather than latched precisely so it can be asserted here.
 */

import { describe, expect, test, vi } from "vitest";
import { warnDuplicatedDefaultPrompt } from "./_prompt-duplicate-warning.ts";

function captured(prompt: string, leading: boolean): string[] {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  warnDuplicatedDefaultPrompt(prompt, { leading, defaultLength: 9876 });
  const lines = warn.mock.calls.map((call) => String(call[0]));
  warn.mockRestore();
  return lines;
}

describe("warnDuplicatedDefaultPrompt", () => {
  test("the LEADING copy says it was dropped", () => {
    // The repair is silent otherwise, which is how the premise survived: an
    // author whose prompt worked had no reason to learn it was being edited.
    const [line] = captured("leading-case-prompt", true);
    expect(line).toContain("[aai]");
    expect(line).toContain("has been dropped");
    expect(line).toContain("APPENDED");
    expect(line).not.toContain("TWICE");
  });

  test("a copy anywhere ELSE says it is being sent twice, and what that costs", () => {
    const [line] = captured("mid-string-case-prompt", false);
    expect(line).toContain("TWICE");
    expect(line).toContain("9876 characters");
    expect(line).toContain("Only a LEADING");
    expect(line).not.toContain("has been dropped");
  });

  test("once per prompt TEXT, not once per process", () => {
    // Keyed by the text, so the line is a function of the input rather than of
    // call order — `createSystemPromptResolver` rebuilds a prompt once a day
    // and a test rebuilds it per case; neither should reprint.
    const prompt = "repeat-case-prompt";
    expect(captured(prompt, false)).toHaveLength(1);
    expect(captured(prompt, false)).toHaveLength(0);
    // A DIFFERENT prompt is still reported.
    expect(captured("another-prompt", false)).toHaveLength(1);
  });
});
