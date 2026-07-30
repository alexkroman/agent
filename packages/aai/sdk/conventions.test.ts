// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_WORKFLOW_SYSTEM_PROMPT } from "./agent-defaults.ts";
import { applyAgentConventions, parseSkillDoc } from "./conventions.ts";
import { agent, tool, workflow } from "./define.ts";
import { anthropic } from "./providers/llm/anthropic.ts";
import { assemblyAI } from "./providers/stt/assemblyai.ts";
import type { ToolContext } from "./types.ts";

const echo = tool({
  description: "Echo a message",
  parameters: z.object({ message: z.string() }),
  execute: ({ message }) => message,
});

function baseAgent() {
  return agent({ name: "Conventions Test" });
}

describe("applyAgentConventions — instructions", () => {
  test("replaces the default agent system prompt", () => {
    const merged = applyAgentConventions(baseAgent(), { instructions: "Be terse.\n" });
    expect(merged.systemPrompt).toBe("Be terse.");
  });

  test("replaces the default workflow system prompt", () => {
    const def = workflow({
      name: "Wf",
      stt: assemblyAI({ model: "u3pro-rt" }),
      llm: anthropic({ model: "claude-sonnet-5" }),
    });
    expect(def.systemPrompt).toBe(DEFAULT_WORKFLOW_SYSTEM_PROMPT);
    const merged = applyAgentConventions(def, { instructions: "Run it." });
    expect(merged.systemPrompt).toBe("Run it.");
  });

  test("errors when agent.ts also sets a custom systemPrompt", () => {
    const def = agent({ name: "A", systemPrompt: "Custom." });
    expect(() => applyAgentConventions(def, { instructions: "Other." })).toThrow(
      /Both instructions\.md and a systemPrompt/,
    );
  });

  test("errors on an empty instructions.md", () => {
    expect(() => applyAgentConventions(baseAgent(), { instructions: "  \n" })).toThrow(
      /instructions\.md is empty/,
    );
  });

  test("no instructions leaves the default prompt in place", () => {
    const merged = applyAgentConventions(baseAgent(), {});
    expect(merged.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

describe("applyAgentConventions — tools", () => {
  test("merges tool modules keyed by filename", () => {
    const merged = applyAgentConventions(baseAgent(), { tools: { echo } });
    expect(merged.tools?.echo).toBe(echo);
  });

  test("keeps tools declared in agent.ts alongside convention tools", () => {
    const def = agent({ name: "A", tools: { inline: echo } });
    const merged = applyAgentConventions(def, { tools: { from_file: echo } });
    expect(Object.keys(merged.tools ?? {}).sort()).toEqual(["from_file", "inline"]);
  });

  test("does not mutate the input definition", () => {
    const def = agent({ name: "A", tools: { inline: echo } });
    applyAgentConventions(def, { tools: { from_file: echo } });
    expect(Object.keys(def.tools ?? {})).toEqual(["inline"]);
  });

  test("errors on a name collision with agent.ts", () => {
    const def = agent({ name: "A", tools: { echo } });
    expect(() => applyAgentConventions(def, { tools: { echo } })).toThrow(
      /defined both in tools\/echo\.ts and in agent\.ts/,
    );
  });

  test("errors when the module is not a tool", () => {
    expect(() => applyAgentConventions(baseAgent(), { tools: { bad: 42 } })).toThrow(
      /tools\/bad\.ts must default-export a tool/,
    );
    expect(() =>
      applyAgentConventions(baseAgent(), { tools: { bad: { description: "x" } } }),
    ).toThrow(/tools\/bad\.ts must default-export a tool/);
  });

  test("errors on an invalid tool filename", () => {
    expect(() => applyAgentConventions(baseAgent(), { tools: { "no spaces": echo } })).toThrow(
      /Invalid tool name/,
    );
  });
});

describe("applyAgentConventions — skills", () => {
  const ctx = {} as ToolContext;

  test("exposes a skill as a skill_<name> tool returning the body", async () => {
    const merged = applyAgentConventions(baseAgent(), {
      skills: { research: "---\ndescription: How to research\n---\nStep 1. Look.\n" },
    });
    const skill = merged.tools?.skill_research;
    expect(skill?.description).toBe('Load the "research" skill: How to research');
    expect(await skill?.execute({}, ctx)).toBe("Step 1. Look.");
  });

  test("dashes in the filename become underscores in the tool name", () => {
    const merged = applyAgentConventions(baseAgent(), {
      skills: { "file-expenses": "---\ndescription: Expense filing\n---\nFill the form." },
    });
    expect(merged.tools?.skill_file_expenses).toBeDefined();
  });

  test("errors on a skill without a front-matter description", () => {
    expect(() => applyAgentConventions(baseAgent(), { skills: { notes: "Take notes." } })).toThrow(
      /skills\/notes\.md has no description/,
    );
  });

  test("errors on an empty skill", () => {
    expect(() =>
      applyAgentConventions(baseAgent(), { skills: { empty: "---\ndescription: x\n---\n" } }),
    ).toThrow(/skills\/empty\.md is empty/);
  });

  test("errors when the generated tool name collides", () => {
    const def = agent({ name: "A", tools: { skill_research: echo } });
    expect(() => applyAgentConventions(def, { skills: { research: "Body." } })).toThrow(
      /would register tool "skill_research"/,
    );
  });
});

describe("parseSkillDoc", () => {
  test("splits front matter from the body", () => {
    expect(parseSkillDoc("---\ndescription: D\n---\nBody")).toEqual({
      description: "D",
      body: "Body",
    });
  });

  test("handles CRLF and missing front matter", () => {
    expect(parseSkillDoc("---\r\ndescription: D\r\n---\r\nBody\r\n")).toEqual({
      description: "D",
      body: "Body",
    });
    expect(parseSkillDoc("Just a body")).toEqual({ body: "Just a body" });
  });

  test("front matter without description yields only the body", () => {
    expect(parseSkillDoc("---\nauthor: me\n---\nBody")).toEqual({ body: "Body" });
  });
});
