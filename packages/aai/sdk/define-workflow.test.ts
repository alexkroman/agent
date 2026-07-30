// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow app mode: `workflow()` definition defaults, the kind rules
 * in parseManifest/toAgentConfig, and the workflow-vs-agent system prompt
 * split. Co-located with define.ts but split from define.test.ts for file
 * length.
 */

import { describe, expect, it } from "vitest";
import { toAgentConfig } from "./_internal-types.ts";
import { DEFAULT_WORKFLOW_GREETING, DEFAULT_WORKFLOW_SYSTEM_PROMPT } from "./agent-defaults.ts";
import { workflow } from "./define.ts";
import { parseManifest } from "./manifest.ts";
import { isTextOnlyTts } from "./providers/tts/none.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

const stt = { kind: "assemblyai", options: { model: "u3pro-rt" } };
const llm = { kind: "anthropic", options: { model: "m" } };
const tts = { kind: "cartesia", options: { voice: "v" } };

describe("workflow()", () => {
  it("marks the definition as a workflow with text-only output", () => {
    const def = workflow({ name: "Filer", stt, llm });
    expect(def.kind).toBe("workflow");
    expect(isTextOnlyTts(def.tts)).toBe(true);
    expect(def.systemPrompt).toBe(DEFAULT_WORKFLOW_SYSTEM_PROMPT);
    expect(def.greeting).toBe(DEFAULT_WORKFLOW_GREETING);
  });

  it("keeps a custom system prompt and greeting", () => {
    const def = workflow({
      name: "Filer",
      stt,
      llm,
      systemPrompt: "File expenses.",
      greeting: "Speak your expense.",
    });
    expect(def.systemPrompt).toBe("File expenses.");
    expect(def.greeting).toBe("Speak your expense.");
    expect(isTextOnlyTts(def.tts)).toBe(true);
  });

  it("passes toAgentConfig validation as a pipeline config", () => {
    const config = toAgentConfig(workflow({ name: "Filer", stt, llm }));
    expect(config).toMatchObject({ kind: "workflow", mode: "pipeline" });
  });
});

describe("kind rules in parseManifest / toAgentConfig", () => {
  it("rejects a workflow manifest without pipeline providers", () => {
    expect(() => parseManifest({ name: "w", kind: "workflow" })).toThrow(/pipeline mode/);
  });

  it("fills the workflow defaults for a bare workflow manifest", () => {
    const manifest = parseManifest({
      name: "w",
      kind: "workflow",
      stt,
      llm,
      tts: { kind: "none", options: {} },
    });
    expect(manifest.systemPrompt).toBe(DEFAULT_WORKFLOW_SYSTEM_PROMPT);
    expect(manifest.greeting).toBe(DEFAULT_WORKFLOW_GREETING);
  });

  it("rejects a workflow manifest carrying a real TTS provider", () => {
    expect(() => parseManifest({ name: "w", kind: "workflow", stt, llm, tts })).toThrow(
      /never speaks/,
    );
  });

  it("rejects tts: none() on an agent manifest — no text-only agents", () => {
    expect(() =>
      parseManifest({ name: "a", stt, llm, tts: { kind: "none", options: {} } }),
    ).toThrow(/only valid for workflows/);
  });

  it("leaves agent-kind defaults untouched", () => {
    const manifest = parseManifest({ name: "a" });
    expect(manifest.kind).toBeUndefined();
    expect(manifest.systemPrompt).not.toBe(DEFAULT_WORKFLOW_SYSTEM_PROMPT);
  });
});

describe("buildSystemPrompt for workflows", () => {
  const workflowConfig = toAgentConfig(workflow({ name: "Filer", stt, llm }));

  it("builds from the workflow base without voice rules or spoken preambles", () => {
    const prompt = buildSystemPrompt(workflowConfig, { hasTools: true, voice: true });
    expect(prompt).toContain("automation workflow");
    expect(prompt).not.toContain("CRITICAL OUTPUT RULES");
    expect(prompt).not.toContain("brief natural phrase BEFORE the tool call");
    expect(prompt).not.toContain("customer service agent");
  });

  it("labels custom instructions as workflow-specific", () => {
    const config = toAgentConfig(
      workflow({ name: "Filer", stt, llm, systemPrompt: "File expenses only." }),
    );
    const prompt = buildSystemPrompt(config, { hasTools: false, voice: true });
    expect(prompt).toContain("Workflow-Specific Instructions:\nFile expenses only.");
    // The one-shot contract stays even with custom instructions.
    expect(prompt).toContain("automation workflow");
  });

  it("keeps the conversational base for agent-kind configs", () => {
    const prompt = buildSystemPrompt(
      { name: "a", systemPrompt: "x", greeting: "g" },
      { hasTools: true, voice: true },
    );
    expect(prompt).toContain("CRITICAL OUTPUT RULES");
    expect(prompt).toContain("customer service agent");
  });
});
