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
    // A "workflow" request must produce workflow(), not a conversational
    // agent() — the mode-selection rule lives in the preamble.
    expect(prompt).toContain('"Workflow" means workflow(), not agent()');
    expect(prompt).toContain("treat changes you didn't make as");
    expect(prompt).not.toContain("deploy_agent");
    expect(prompt).toContain("no `aai` CLI");
    // The full scaffold reference follows.
    expect(prompt).toContain("# aai framework reference (scaffold CLAUDE.md)");
    expect(prompt).toContain("## `agent()` API");
    expect(prompt).toContain("Voice rules for systemPrompt");
  });

  test("teaches shape discovery, not just the word 'workflow'", () => {
    // Hard-wrapped prose, so assert against a whitespace-normalized copy —
    // a reflow shouldn't fail these.
    const prompt = studioSystemPrompt().replace(/\s+/g, " ");
    // The existing rule keys on the user *saying* "workflow". Real requests
    // describe the job instead ("I ramble into my phone and it files
    // everything"), which is how a one-shot ask came out as a chat agent.
    expect(prompt).toContain("Recognize a workflow even when the user never says the word");
    expect(prompt).toContain("talks *with* the app (agent()) or *at* it once (workflow())");
    // The observed failure: a hand-rolled `const workflow = (config) =>
    // ({ ...config, mode: "workflow" })`. Neither field is an authoring field.
    expect(prompt).toContain("Import workflow(), never re-create it");
    expect(prompt).toContain(
      'a local `const workflow = (config) => ({ ...config, mode: "workflow" })`',
    );
    expect(prompt).toContain("`kind` and `mode` are not authoring fields at all");
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

  test("excludes the CLI Workflow section without taking the workflow() API with it", () => {
    const guide = loadScaffoldGuide();
    // Two headings in the guide match the word the preamble excludes. The
    // first genuinely doesn't apply in the studio; the second is an app shape
    // that does. A bare "ignore the Workflow section" took both and the studio
    // stopped emitting workflows — see this module's header comment.
    expect(guide).toContain("## Workflow\n");
    expect(guide).toContain("## `workflow()` API");

    const prompt = studioSystemPrompt().replace(/\s+/g, " ");
    // The exclusion has to name what it means precisely...
    expect(prompt).toContain("`pnpm dev` / `pnpm test` / `pnpm build` loop");
    // ...and say outright that the similarly-named section is not included.
    expect(prompt).toContain('the "`workflow()` API" section is a different thing');
    expect(prompt).toContain("it applies here in full");
  });

  test("is cached across calls", () => {
    expect(studioSystemPrompt()).toBe(studioSystemPrompt());
  });

  test("falls back to the built-in guide when the scaffold file is absent", () => {
    const prompt = composeStudioPrompt(null);
    expect(prompt).toContain("AssemblyAI App Builder coding agent");
    expect(prompt).toContain("agent() essentials");
    // The fallback guide must still cover the workflow() app mode...
    expect(prompt).toContain("use workflow(), never agent()");
    // ...including the rule against re-creating the helper, since this path
    // is the *only* guide the agent gets when the scaffold isn't on disk.
    expect(prompt).toContain("never define a local workflow helper");
    expect(prompt).not.toContain("## `agent()` API"); // scaffold-only heading
  });
});
