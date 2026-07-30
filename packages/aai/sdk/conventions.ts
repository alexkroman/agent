// Copyright 2026 the AAI authors. MIT license.
/**
 * Filesystem authoring conventions — the merge half.
 *
 * Agent directories may declare parts of their definition as conventional
 * files alongside `agent.ts` (the authoring model popularized by Vercel's
 * eve framework):
 *
 * - `instructions.md` — the system prompt
 * - `tools/<name>.ts` — one tool per file, default-exporting `tool({...})`;
 *   the filename is the tool name
 * - `skills/<name>.md` — on-demand procedures with a front-matter
 *   `description`, each exposed to the LLM as a zero-argument `skill_<name>`
 *   tool that returns the document
 *
 * Discovery is a bundler concern (the CLI walks the directory and generates
 * an entry module); this module is the **runtime merge** that generated
 * entry calls. It lives in `sdk/` — no Node.js imports — because the merge
 * executes inside the agent bundle, in whatever environment loads it (the
 * Deno guest sandbox, the CLI's eval step, `aai dev`).
 *
 * Every conflict is an error rather than a precedence rule: a convention
 * file that silently loses to `agent.ts` (or vice versa) reads as the
 * framework ignoring the author's file, which is the failure mode this
 * authoring model exists to avoid.
 */

import { DEFAULT_SYSTEM_PROMPT, DEFAULT_WORKFLOW_SYSTEM_PROMPT } from "./agent-defaults.ts";
import type { AgentDef, ToolDef } from "./types.ts";

/**
 * Convention inputs discovered next to `agent.ts`, as raw file contents /
 * module exports. Produced by the CLI's generated entry — see
 * `aai-cli/_conventions.ts` for the discovery half.
 *
 * @public
 */
export type AgentConventions = {
  /** Contents of `instructions.md`, verbatim. */
  instructions?: string;
  /**
   * Default exports of `tools/<name>.ts` modules keyed by tool name (the
   * filename without extension). Typed `unknown` so a file that forgot to
   * export a `tool({...})` fails here with a message naming the file,
   * instead of downstream with a schema error naming nothing.
   */
  tools?: Record<string, unknown>;
  /** Contents of `skills/<name>.md` files keyed by skill name, verbatim. */
  skills?: Record<string, string>;
};

/** Tool and skill names come from filenames — keep them LLM-tool-name safe. */
const VALID_CONVENTION_NAME = /^[a-zA-Z0-9_-]+$/;

/** Prefix for tools generated from `skills/*.md`. */
export const SKILL_TOOL_PREFIX = "skill_";

function isToolDef(value: unknown): value is ToolDef {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { description?: unknown; execute?: unknown };
  return typeof candidate.description === "string" && typeof candidate.execute === "function";
}

function assertValidName(kind: "tool" | "skill", name: string): void {
  if (!VALID_CONVENTION_NAME.test(name)) {
    throw new Error(
      `Invalid ${kind} name "${name}" — ${kind} filenames may only use letters, digits, "_" and "-".`,
    );
  }
}

/**
 * Front matter is deliberately minimal: an optional leading `---` block of
 * `key: value` lines, of which only `description` is read. Anything fancier
 * (YAML lists, nesting) belongs in the skill body.
 */
export function parseSkillDoc(raw: string): { description?: string; body: string } {
  const text = raw.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { body: text.trim() };
  const body = text.slice(match[0].length).trim();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const kv = /^description\s*:\s*(.+)$/.exec(line.trim());
    if (kv?.[1]) return { description: kv[1].trim(), body };
  }
  return { body };
}

function skillToTool(name: string, raw: string): ToolDef {
  const { description, body } = parseSkillDoc(raw);
  if (!body) throw new Error(`skills/${name}.md is empty — add the procedure or delete the file.`);
  if (!description) {
    throw new Error(
      `skills/${name}.md has no description — start the file with front matter ` +
        `("---", "description: when to use this skill", "---") so the LLM knows when to load it.`,
    );
  }
  return {
    description: `Load the "${name}" skill: ${description}`,
    execute: () => body,
  };
}

function mergeInstructions(def: AgentDef, instructions: string): string {
  const trimmed = instructions.trim();
  if (!trimmed) {
    throw new Error("instructions.md is empty — add the system prompt or delete the file.");
  }
  const isDefaultPrompt =
    def.systemPrompt === DEFAULT_SYSTEM_PROMPT ||
    def.systemPrompt === DEFAULT_WORKFLOW_SYSTEM_PROMPT;
  if (!isDefaultPrompt) {
    throw new Error(
      "Both instructions.md and a systemPrompt in agent.ts are set — " +
        "move the prompt into instructions.md or delete the file.",
    );
  }
  return trimmed;
}

/**
 * Merge convention files into an agent definition.
 *
 * Called from the bundler-generated entry, after `agent()`/`workflow()` has
 * applied its defaults — which is what lets `instructions.md` distinguish
 * "author never set a prompt" (the default is still in place → replace it)
 * from "author set one in code" (→ error, two sources of truth).
 *
 * @public
 */
export function applyAgentConventions(def: AgentDef, conventions: AgentConventions): AgentDef {
  const tools: Record<string, ToolDef> = { ...def.tools };

  for (const [name, mod] of Object.entries(conventions.tools ?? {})) {
    assertValidName("tool", name);
    if (!isToolDef(mod)) {
      throw new Error(
        `tools/${name}.ts must default-export a tool created with tool({ description, execute }).`,
      );
    }
    if (name in tools) {
      throw new Error(
        `Tool "${name}" is defined both in tools/${name}.ts and in agent.ts — remove one.`,
      );
    }
    tools[name] = mod;
  }

  for (const [name, raw] of Object.entries(conventions.skills ?? {})) {
    assertValidName("skill", name);
    const toolName = `${SKILL_TOOL_PREFIX}${name.replaceAll("-", "_")}`;
    if (toolName in tools) {
      throw new Error(
        `Skill "${name}" would register tool "${toolName}", which already exists — rename one.`,
      );
    }
    tools[toolName] = skillToTool(name, raw);
  }

  return {
    ...def,
    tools,
    ...(conventions.instructions !== undefined
      ? { systemPrompt: mergeInstructions(def, conventions.instructions) }
      : {}),
  };
}
