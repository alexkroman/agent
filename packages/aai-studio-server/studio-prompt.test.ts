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

/**
 * The workflow prompt is a different PRODUCT's instructions, not a variant of
 * the same one, so these assert the substitutions that make it so — and, just as
 * importantly, that an agent project's prompt is untouched by any of it.
 */
describe("studioSystemPrompt for a workflow project", () => {
  test("tells the agent it is building a static page over durable steps", () => {
    const prompt = studioSystemPrompt("workflow");
    expect(prompt).toContain("THIS PROJECT IS A WORKFLOW APP, NOT A VOICE AGENT");
    // The three declarations a workflow project cannot work without.
    expect(prompt).toContain('page: "static"');
    expect(prompt).toContain("workflows: { process }");
    expect(prompt).toContain("page({ name:");
  });

  test("names what no longer applies, since the shared preamble is voice-shaped", () => {
    const prompt = studioSystemPrompt("workflow");
    // Disclaiming by name is the sharp tool the preamble's own header warns
    // about; a workflow project that writes a greeting and a voice produces an
    // app whose page cannot open at all.
    expect(prompt).toContain("No `greeting`, no `voice`, no `systemPrompt`");
    expect(prompt).toContain("never `client()`");
    expect(prompt).toContain("Do NOT use useSession");
  });

  test("points at the worked example rather than describing it", () => {
    // `use_template` copies files verbatim; a re-derivation from prose is what
    // this line exists to prevent.
    expect(studioSystemPrompt("workflow")).toContain("transcription-desk");
  });

  test("keeps the shared coding guidance — it is one preamble, not two", () => {
    const workflow = studioSystemPrompt("workflow");
    const agent = studioSystemPrompt("agent");
    for (const shared of ["AssemblyAI Build coding agent", "test_agent", "## Refusals"]) {
      expect(workflow).toContain(shared);
      expect(agent).toContain(shared);
    }
  });

  test("an agent project gets NONE of the workflow addendum", () => {
    // The regression that would be invisible: a voice project told to write a
    // static page still builds, and merely serves nothing anyone can talk to.
    const agent = studioSystemPrompt("agent");
    expect(agent).not.toContain("THIS PROJECT IS A WORKFLOW APP");
    // Identified by the addendum's own markers: the scaffold guide (which BOTH
    // prompts carry) documents `page: "static"` too, so that string alone would
    // pass for the wrong reason.
    // Markers unique to the ADDENDUM. The scaffold guide — which BOTH prompts
    // carry — documents `page: "static"`, `workflows: { process }` and a
    // "do not use useSession" rule of its own, so any of those would pass here
    // for the wrong reason.
    expect(agent).not.toContain("Read this section as overriding anything above it");
    expect(agent).not.toContain("Read the worked example first");
    // The default argument is the agent prompt, so an un-updated caller cannot
    // silently get the workflow one.
    expect(studioSystemPrompt()).toBe(agent);
  });

  test("each kind is cached separately", () => {
    expect(studioSystemPrompt("workflow")).toBe(studioSystemPrompt("workflow"));
    expect(studioSystemPrompt("workflow")).not.toBe(studioSystemPrompt("agent"));
  });
});
