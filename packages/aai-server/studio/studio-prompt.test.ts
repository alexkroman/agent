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
    // Concrete design rules for client.tsx live in the guide (one source of
    // truth for CLI and studio) — the studio preamble points at this heading
    // by name, so a rename here would silently break that reference.
    expect(guide).toContain("### Design guidelines");
  });

  test("returns null for a missing path", () => {
    expect(loadScaffoldGuide("/nonexistent/CLAUDE.md")).toBeNull();
  });
});

describe("studioSystemPrompt", () => {
  test("composes the studio preamble with the scaffold guide", () => {
    const prompt = studioSystemPrompt();
    // Studio preamble (workflow + environment overrides).
    expect(prompt).toContain("AssemblyAI App Builder coding agent");
    expect(prompt).toContain("test_agent");
    // Any non-AssemblyAI provider needs a key the user must supply, so a
    // generated agent should default to the one key publishing guarantees.
    expect(prompt).toContain("Default to AssemblyAI for every provider");
    // Real gateway ids are interpolated so the agent can't invent one
    // (a made-up id only fails at runtime, with a 400 "model not found").
    // gpt-5.2 appears nowhere in the preamble literal, so it can only be here
    // if the ASSEMBLYAI_GATEWAY_MODELS interpolation ran.
    expect(prompt).toContain("gpt-5.2");
    // The pipeline default the quickstart also asks for.
    expect(prompt).toContain('"gemini-2.5-flash-lite" for a fast, cheap voice agent');
    // Publishing is the user's call, so the agent must be told it cannot.
    expect(prompt).toContain("You cannot publish");
    // Working-style rules: implement with tools instead of pasting code
    // into chat, and respect edits the user makes in the code editor.
    expect(prompt).toContain("Act, don't propose");
    expect(prompt).toContain("treat changes you didn't make as");
    // Context-gathering discipline: parallel independent tool calls, and
    // don't pick an edit site off the first grep hit. Hard-wrapped prose,
    // so assert against a whitespace-normalized copy.
    const flat = prompt.replace(/\s+/g, " ");
    expect(flat).toContain("don't stop at the first match");
    // Custom UI gets concrete design constraints, not just "look nice" —
    // the preamble names the guide section that carries the full rules.
    expect(flat).toContain('"Design guidelines" section of the reference');
    expect(prompt).not.toContain("deploy_agent");
    expect(prompt).toContain("no `aai` CLI");
    // The full scaffold reference follows.
    expect(prompt).toContain("# aai framework reference (scaffold CLAUDE.md)");
    expect(prompt).toContain("## `agent()` API");
    expect(prompt).toContain("Voice rules for systemPrompt");
  });

  test("lists the SDK's real subpaths and corrects the /workflow guess", () => {
    const prompt = studioSystemPrompt().replace(/\s+/g, " ");
    expect(prompt).toContain("Never invent an SDK subpath");
    // Interpolated from the package's own exports map, so it can't drift.
    // "patterns" appears nowhere in the preamble literal, only in that list.
    expect(prompt).toContain("@alexkroman1/aai/patterns");
    // The combinators' subpath was renamed from /workflow, so the old name is
    // in the model's priors and in any pre-rename docs snapshot. A list alone
    // doesn't dislodge a wrong belief; the contradiction is stated outright.
    expect(prompt).toContain('**not** "@alexkroman1/aai/workflow", which does not exist');
  });

  test("excludes the CLI Workflow section by its precise contents", () => {
    const guide = loadScaffoldGuide();
    expect(guide).toContain("## Workflow\n");

    const prompt = studioSystemPrompt().replace(/\s+/g, " ");
    // The exclusion has to name what it means precisely.
    expect(prompt).toContain("`pnpm dev` / `pnpm test` / `pnpm build` loop");
  });

  test("is cached across calls", () => {
    expect(studioSystemPrompt()).toBe(studioSystemPrompt());
  });

  test("falls back to the built-in guide when the scaffold file is absent", () => {
    const prompt = composeStudioPrompt(null);
    expect(prompt).toContain("AssemblyAI App Builder coding agent");
    expect(prompt).toContain("agent() essentials");
    // The preamble points at a "Design guidelines" section; the fallback is
    // the only guide on this path, so it must carry one of its own.
    expect(prompt).toContain("## Design guidelines (client.tsx)");
    expect(prompt).not.toContain("## `agent()` API"); // scaffold-only heading
  });
});
