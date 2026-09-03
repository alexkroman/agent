// Copyright 2026 the AAI authors. MIT license.
/**
 * `system-prompt.md` beside `agent.ts` becoming the agent's system prompt.
 *
 * Not to be confused with `system-prompt.ts` next door, which is the prompt's
 * CONTENT — the default and the section builder. This module is the same job
 * `tool-registry.ts` does for `tools/`: turning something the filesystem
 * declares into a field on the definition, with the rules in one place and every
 * diagnostic naming the file.
 *
 * **Why a prompt is a file and a greeting is not.** A system prompt is a
 * DOCUMENT — a paragraph, headings, a bulleted list — and written inline it is
 * that document spelled as `\n\n` and `\n-` escapes inside a single-line string
 * literal: no wrapping, no preview, and one line in every diff no matter which
 * bullet changed. Prompt iteration is the main loop of authoring an agent, so
 * that is the edit landing in the least reviewable place available. A greeting is
 * one sentence with no structure to lose, and it crosses the wire in
 * `/client-config` beside `name` and `page`; those three are values and stay in
 * the call. The line is **a document goes in a file, a value stays in the call**.
 *
 * **The filesystem read is deliberately NOT here**, for the reason
 * `tool-registry.ts` gives: the guest sandbox loads one ESM string and has no
 * directory to scan, so the read happens where the bundle is assembled and the
 * text arrives here already loaded.
 */

import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import type { AgentDef } from "./types.ts";

/**
 * Attach a discovered `system-prompt.md` to an agent definition.
 *
 * Three outcomes, decided by comparing VALUES rather than by reading source:
 *
 * 1. The def carries the framework default — the author declared no
 *    `systemPrompt` — so the file becomes it.
 * 2. The def's prompt CONTAINS the file's text: the author imported it, either
 *    verbatim or composed with more around it (a menu, a computed suffix). Left
 *    exactly as the author built it.
 * 3. Neither: a `system-prompt.md` exists and nothing reads it, while the agent
 *    declares a different prompt. That is an ERROR.
 *
 * **Outcome 3 is the whole point of the function.** "I edited
 * `system-prompt.md` and nothing changed" is the silent-absence failure tool
 * discovery was introduced to kill, pointing the other way — and it is worse
 * here, because a prompt is edited far more often than a tool is added, and a
 * prompt that is quietly ignored produces an agent that behaves plausibly and
 * wrongly rather than one that visibly cannot do something.
 *
 * Comparing values is also what answers the question this could not otherwise
 * answer. "Does `agent.ts` reference the file?" invites either a scrape of
 * source text (fragile) or a question to the bundler's module graph (unavailable
 * at entry-generation time, since the entry is written before the build). The
 * resolved prompt answers it directly, and composition needs no special case.
 *
 * Generic in the def so a caller gets back the type it passed in —
 * `deployedAgent` (`@alexkroman1/aai/testing`) composes this with the tools
 * lowering beside it, which is generic for the same reason, and a widened
 * `AgentDef` in the middle of that pipeline would throw away a template's own
 * exported workflow types.
 *
 * @internal
 */
export function withSystemPrompt<D extends AgentDef>(def: D, prompt: string): D {
  const trimmed = prompt.trim();
  if (trimmed === "") {
    throw new Error(
      "system-prompt.md is empty. A file with nothing in it is not a prompt — write one, or delete the file and take the framework default.",
    );
  }
  if (def.systemPrompt === DEFAULT_SYSTEM_PROMPT) return { ...def, systemPrompt: prompt };
  if (def.systemPrompt.includes(trimmed)) return def;
  throw new Error(
    'system-prompt.md exists and nothing reads it: agent.ts declares a different `systemPrompt`. Remove the field to let the file be the prompt, or import the file and compose it (`import prompt from "./system-prompt.md?raw"`) if the agent really builds its prompt from more than one piece.',
  );
}
