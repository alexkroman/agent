// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import path from "node:path";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL } from "@alexkroman1/aai/llm";
import { afterEach, describe, expect, test } from "vitest";
import {
  _resetStudioPromptCache,
  composeStudioPrompt,
  loadScaffoldGuide,
  scaffoldGuidePath,
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

  // Regression: the path used to be a relative `../aai-templates/...` walk
  // from import.meta.dirname, which is only correct for the SOURCE layout.
  // From the built bundle (`dist/`) it pointed inside aai-studio-server, so
  // production silently served FALLBACK_GUIDE. Asserting the resolved path
  // lands in the aai-templates package catches that regardless of where the
  // module runs from — the previous test could not, because it runs from
  // source, where the broken path happened to work.
  test("resolves into the aai-templates package, not relative to the bundle", () => {
    const resolved = scaffoldGuidePath();
    expect(resolved).toContain(`${path.sep}aai-templates${path.sep}scaffold${path.sep}`);
    expect(resolved).not.toContain(`${path.sep}aai-studio-server${path.sep}aai-templates`);
    expect(existsSync(resolved)).toBe(true);
  });
});

describe("studioSystemPrompt", () => {
  test("composes the studio preamble with the scaffold guide", () => {
    const prompt = studioSystemPrompt();
    // Studio preamble (workflow + environment overrides).
    expect(prompt).toContain("AssemblyAI Build coding agent");
    expect(prompt).toContain("test_agent");
    // Any non-AssemblyAI provider needs a key the user must supply, so a
    // generated agent should default to an all-AssemblyAI pipeline (STT +
    // the gateway LLM + TTS) on the one key publishing guarantees, with the
    // S2S voice agent API only on request. Both are graded by the
    // CONFIG_CASES half of the studio codegen evals.
    expect(prompt).toContain("Default to a cascaded (pipeline-mode) agent");
    // The zero-import golden path: no provider fields, `voice` for the TTS
    // voice. The preamble must teach it explicitly — it outranks the
    // scaffold reference, and when it spelled out the long form, 11 of 11
    // starter-eval agents wrote the three stage-factory imports by hand.
    expect(prompt).toContain("declaring no provider fields at all");
    expect(prompt).toContain('voice: "jane"');
    // The preset survives only as the EU-residency spelling.
    expect(prompt).toContain("assemblyAIPipeline");
    // Real gateway ids are interpolated so the agent can't invent one
    // (a made-up id only fails at runtime, with a 400 "model not found").
    // gpt-5.2 appears nowhere in the preamble literal, so it can only be here
    // if the ASSEMBLYAI_GATEWAY_MODELS interpolation ran.
    expect(prompt).toContain("gpt-5.2");
    // The default gateway model for generated pipeline agents, read from the
    // SDK constant rather than spelled out: the preamble interpolates it, so
    // changing the SDK default can no longer leave the prompt naming the old
    // one (which is exactly how it drifted before).
    expect(prompt).toContain(
      `"${ASSEMBLYAI_LLM_DEFAULT_MODEL}" unless the user asks for a different model`,
    );
    expect(prompt).toContain(`universal-3-5-pro,\n  ${ASSEMBLYAI_LLM_DEFAULT_MODEL}, jane`);
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
    expect(flat).toContain("Don't stop at the first match");
    // The v0-style arc: refusals and alignment examples close the preamble.
    expect(prompt).toContain("## Refusals");
    expect(prompt).toContain("REFUSAL_MESSAGE");
    expect(prompt).toContain("## Alignment");
    // Pipeline is the default; the S2S voice agent API is opt-in only.
    expect(flat).toContain(
      "Use the AssemblyAI voice agent API (S2S mode) only when the user asks for it",
    );
    expect(flat).toContain("s2s: assemblyAIS2s()");
    expect(flat).toContain("there is no way to reach S2S by omission");
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

  test("lists the SDK's real subpaths without naming removed ones", () => {
    const prompt = studioSystemPrompt().replace(/\s+/g, " ");
    expect(prompt).toContain("Never invent an SDK subpath");
    // Interpolated from the package's own exports map, so it can't drift.
    expect(prompt).toContain("@alexkroman1/aai/llm");
    // The removed combinator subpaths are not mentioned at all — not even
    // as a contradiction — so the prompt can't teach their names.
    expect(prompt).not.toContain("@alexkroman1/aai/patterns");
    expect(prompt).not.toContain("@alexkroman1/aai/workflow");
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
    expect(prompt).toContain("AssemblyAI Build coding agent");
    expect(prompt).toContain("agent() essentials");
    // The preamble points at a "Design guidelines" section; the fallback is
    // the only guide on this path, so it must carry one of its own.
    expect(prompt).toContain("## Design guidelines (client.tsx)");
    expect(prompt).not.toContain("## `agent()` API"); // scaffold-only heading
  });
});
