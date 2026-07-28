// Copyright 2025 the AAI authors. MIT license.

import { afterEach, describe, expect, test } from "vitest";
import {
  _resetStudioPromptCache,
  composeStudioPrompt,
  loadScaffoldGuide,
  studioSystemPrompt,
} from "./studio-prompt.ts";

afterEach(() => {
  _resetStudioPromptCache();
});

describe("loadScaffoldGuide", () => {
  test("loads the CLI's scaffold CLAUDE.md from the monorepo", () => {
    const guide = loadScaffoldGuide();
    expect(guide).toBeTruthy();
    // Markers proving it is the real CLI authoring guide, not a copy.
    expect(guide).toContain("## `agent()` API");
    expect(guide).toContain("AssemblyAI LLM");
  });

  test("returns null for a missing path", () => {
    expect(loadScaffoldGuide("/nonexistent/CLAUDE.md")).toBeNull();
  });
});

describe("studioSystemPrompt", () => {
  test("composes the studio preamble with the scaffold guide", () => {
    const prompt = studioSystemPrompt();
    // Studio preamble (workflow + environment overrides).
    expect(prompt).toContain("AAI Studio coding agent");
    expect(prompt).toContain("test_agent");
    // Publishing is the user's call, so the agent must be told it cannot.
    expect(prompt).toContain("You cannot publish");
    expect(prompt).not.toContain("deploy_agent");
    expect(prompt).toContain("no `aai` CLI");
    // The full scaffold reference follows.
    expect(prompt).toContain("# aai framework reference (scaffold CLAUDE.md)");
    expect(prompt).toContain("## `agent()` API");
    expect(prompt).toContain("Voice rules for systemPrompt");
  });

  test("is cached across calls", () => {
    expect(studioSystemPrompt()).toBe(studioSystemPrompt());
  });

  test("falls back to the built-in guide when the scaffold file is absent", () => {
    const prompt = composeStudioPrompt(null);
    expect(prompt).toContain("AAI Studio coding agent");
    expect(prompt).toContain("agent() essentials");
    expect(prompt).not.toContain("## `agent()` API"); // scaffold-only heading
  });
});
