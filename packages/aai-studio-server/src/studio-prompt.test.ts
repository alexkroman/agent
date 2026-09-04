// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import path from "node:path";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL } from "@alexkroman1/aai/llm";
import { afterEach, describe, expect, test } from "vitest";
import { STUDIO_LLM_MODELS } from "./studio-llm.ts";
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
    // Read from the roster, never a hardcoded `gpt-5.2`: that literal failed
    // this test the day the model was retired with no defect behind it, and a
    // STALE roster still containing it passed just as happily. The floor is
    // what stops an EMPTY roster satisfying the filter vacuously — the
    // assertion beside it at `ASSEMBLYAI_LLM_DEFAULT_MODEL` gets this right.
    expect(STUDIO_LLM_MODELS.length).toBeGreaterThan(1);
    expect(STUDIO_LLM_MODELS.filter((model) => !prompt.includes(model))).toEqual([]);
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
    expect(prompt).toContain("@alexkroman1/aai/workflow-api");
    // The removed combinator subpaths are not mentioned at all — not even
    // as a contradiction — so the prompt can't teach their names.
    //
    // Matched EXACTLY rather than as a substring, and the reason is live:
    // `@alexkroman1/aai/workflow-api` is a real subpath whose name starts with
    // the removed `/workflow`, so a `toContain` check turns a legitimate export
    // into a failure that reads as the removed one coming back.
    for (const removed of ["patterns", "workflow"]) {
      expect(prompt).not.toMatch(new RegExp(`@alexkroman1/aai/${removed}(?![\\w-])`));
    }
  });

  test("excludes the CLI Workflow section by its precise contents", () => {
    const guide = loadScaffoldGuide();
    expect(guide).toContain("## Workflow\n");

    const prompt = studioSystemPrompt().replace(/\s+/g, " ");
    // The exclusion has to name what it means precisely.
    expect(prompt).toContain("`pnpm dev` / `pnpm test` / `pnpm build` loop");
  });

  test("is cached across calls, per kind", () => {
    expect(studioSystemPrompt()).toBe(studioSystemPrompt());
    expect(studioSystemPrompt("workflow")).toBe(studioSystemPrompt("workflow"));
    // One cache entry per kind, not one entry the second caller overwrites —
    // a studio replica serves both kinds, interleaved.
    expect(studioSystemPrompt("agent")).not.toBe(studioSystemPrompt("workflow"));
  });

  test("defaults to the voice-agent prompt", () => {
    // Every project written before the switcher existed is a voice agent, and
    // so is every caller that names no kind (the CLI's first push, evals).
    expect(studioSystemPrompt()).toBe(studioSystemPrompt("agent"));
  });

  test("names the transcription-workflow template in the workflow prompt", () => {
    // The mode's default is a STATIC workflow app, and the template is how it
    // gets one: `use_template` lands the whole working front door (form,
    // durable body, webhook resume, watching page) where a prose description
    // lands the agent's best guess at it. The other workflow shape — a voice
    // agent whose tool starts a run — is what a model reaches for unprompted,
    // so the prompt has to name the file to copy, not just describe the shape.
    const prompt = studioSystemPrompt("workflow").replace(/\s+/g, " ");
    expect(prompt).toContain("Default to a STATIC workflow app");
    expect(prompt).toContain("Start from the `transcription-workflow` template");
    expect(prompt).toContain("use_template");
    // Mounted with mountPage(), never mountClient() — a static page opened as
    // a session dials a /websocket the server declines.
    expect(prompt).toContain("mountPage({ name, component })");
    // The escape hatch it must NOT take: workflowApp() is that declaration
    // with the discriminant already set, and the fields it refuses are refused
    // on purpose.
    expect(prompt).toContain('agent({ page: "static" })');
    // Bodies are transformed only under workflows/.
    expect(prompt).toContain("Bodies go in `workflows/*.ts` and nowhere else");
  });

  test("the workflow prompt does not gate the build on a database", () => {
    // The prompt has been wrong in BOTH directions here, which is why it is
    // pinned. It first said a workflow app "NEEDS the database … until they do,
    // starting a run fails", turning every project's first turn into an
    // instruction to flip a switch it did not need. It then said runs are not
    // durable without one — true of the DevKit's local world, and false once the
    // platform started keeping every deployed app's runs on its own database.
    //
    // So the assertions are: no switch is mentioned (there is none to flip), and
    // the ONE real limitation is still named.
    const prompt = studioSystemPrompt("workflow").replace(/\s+/g, " ");
    expect(prompt).toContain("Runs are DURABLE with no setup");
    expect(prompt).not.toContain("It NEEDS the database");
    // The dead switch, asserted as an ABSENCE: recommending it sends the user to
    // a pane that no longer exists.
    expect(prompt).not.toContain("Settings → Database");
    expect(prompt).not.toContain("aai storage enable");
    // And now the THIRD direction, which is why the comment above says "both"
    // and this says otherwise: uploads used to be the one real limitation — an
    // upload's record needed a database the author supplied, so a run outlived
    // its own bytes — and they are the platform's too now (`platform-uploads.ts`,
    // the `workflow_uploads` table). So the exception is GONE, and what has to
    // be absent is the advice it justified: a deployed app needs no database of
    // its own for durability of either half, and telling an author to set one
    // sends them to provision something the platform already provides.
    expect(prompt).toContain("File UPLOADS are durable with no setup");
    expect(prompt).not.toContain("A file UPLOAD is the exception");
    expect(prompt).not.toContain("set a DATABASE_URL secret if you want");
    // And the SCAFFOLD GUIDE has to agree, which is the half a preamble
    // assertion cannot reach: `studioSystemPrompt` is the preamble PLUS that
    // guide, so retiring the exception from one of them left the prompt saying
    // both things at once — under different wording, so every assertion above
    // still passed. These are the guide's own sentences.
    expect(prompt).not.toContain("One thing does need a database whatever the run does");
    expect(prompt).not.toContain("refuse by name without a `DATABASE_URL`");
  });

  test("the two prompts share everything that is not mode-specific", () => {
    // The workflow prompt is the SAME arc with five fragments swapped, not a
    // second preamble: the tools, the write-then-typecheck inner loop, the
    // "you cannot publish" rule, the refusals and the whole reference below
    // are identical, and two copies of that would drift within a release.
    const workflow = studioSystemPrompt("workflow");
    for (const shared of [
      "AssemblyAI Build coding agent",
      "test_agent",
      "You cannot publish",
      "Act, don't propose",
      "## Refusals",
      "Default to a cascaded (pipeline-mode) agent",
      "# aai framework reference (scaffold CLAUDE.md)",
      "## `agent()` API",
    ]) {
      expect(workflow, shared).toContain(shared);
    }
    // And the voice-agent guidance that WOULD contradict it is gone: nothing
    // here speaks, so there is no prompt or greeting to write voice rules for.
    expect(workflow).not.toContain("Replies are spoken aloud");
    expect(workflow).toContain("Nothing here is spoken");
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
