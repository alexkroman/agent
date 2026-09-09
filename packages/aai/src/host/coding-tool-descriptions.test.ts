// Copyright 2026 the AAI authors. MIT license.
/**
 * The prose the coding agent's model reads, and the numbers it quotes.
 *
 * No snapshot, on purpose: these descriptions are TUNED, so a snapshot fails
 * on every improvement while catching neither of the two things that actually
 * go wrong. Those two are what this file asserts — a description with no tool
 * (or a tool with no description), and a quoted number the code does not
 * enforce.
 */

import { describe, expect, test } from "vitest";
import {
  BASH_TIMEOUT_MAX_MS,
  BASH_TIMEOUT_MS,
  CODING_TOOL_DESCRIPTIONS,
  GLOB_LIMIT,
  READ_LIMIT,
} from "./coding-tool-descriptions.ts";
import { createCodingTools } from "./coding-tools.ts";

describe("the coding tool descriptions", () => {
  test("describe exactly the tools the factory builds", () => {
    expect(Object.keys(CODING_TOOL_DESCRIPTIONS).sort()).toEqual(
      Object.keys(createCodingTools({ dir: import.meta.dirname })).sort(),
    );
  });

  test.each(Object.entries(CODING_TOOL_DESCRIPTIONS))("%s reads as real prose", (_name, text) => {
    expect(text.trim()).toBe(text);
    expect(text.length).toBeGreaterThan(40);
    // Each is a template literal, so a constant renamed out from under one
    // lands in the model's context as a word.
    expect(text).not.toMatch(/undefined|NaN|\[object Object\]/);
    // The first line is what a tool list renders; it has to say what the tool
    // does on its own.
    expect(text.split("\n")[0]?.length ?? 0).toBeGreaterThan(20);
  });

  test("quote the same numbers the tools enforce", () => {
    expect(CODING_TOOL_DESCRIPTIONS.glob).toContain(String(GLOB_LIMIT));
    expect(CODING_TOOL_DESCRIPTIONS.bash).toContain(`default ${BASH_TIMEOUT_MS}ms`);
    expect(CODING_TOOL_DESCRIPTIONS.bash).toContain(`max ${BASH_TIMEOUT_MAX_MS}ms`);
    // Ordering, so a swap of the two bash budgets cannot pass: the default has
    // to be reachable under the cap.
    expect(BASH_TIMEOUT_MS).toBeLessThan(BASH_TIMEOUT_MAX_MS);
    expect(CODING_TOOL_DESCRIPTIONS.read_file).toContain("offset/limit");
    expect(READ_LIMIT).toBeGreaterThan(0);
  });

  test("name no tool this module does not define", () => {
    // The overridable half of the contract: a host adds `add_dependency` or
    // `test_agent` and describes it itself. A generic description naming one
    // is a description that goes stale silently, in a host that has no such
    // tool.
    const names = Object.keys(CODING_TOOL_DESCRIPTIONS);
    // The snake_case words that are not tool names: a directory every
    // description mentions, and one of `todo_write`'s own status values.
    const notTools = new Set(["node_modules", "in_progress"]);
    for (const [tool, text] of Object.entries(CODING_TOOL_DESCRIPTIONS)) {
      for (const [word] of text.matchAll(/\b[a-z]+_[a-z_]+\b/g)) {
        if (notTools.has(word)) continue;
        expect(names, `${tool} mentions ${word}`).toContain(word);
      }
    }
  });
});
