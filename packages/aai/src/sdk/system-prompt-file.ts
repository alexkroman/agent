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
 * **The prompt is a file, and ONLY a file.** `AgentDef.systemPrompt` is not a
 * parameter of `agent()` (`FrameworkOwnedField`, `agent-params.ts`; refused at
 * run time too): a system prompt is a DOCUMENT — a paragraph, headings, a
 * bulleted list — and written inline it is that document spelled as `\n\n` and
 * `\n-` escapes inside a single-line string literal, one line in every diff no
 * matter which bullet changed. Prompt iteration is the main loop of authoring
 * an agent, so that is the edit landing in the least reviewable place
 * available. A greeting is one sentence with no structure to lose, and it
 * crosses the wire in `/client-config` beside `name` and `page`; those stay in
 * the call. The line is **a document goes in a file, a value stays in the
 * call** — and text computed beside the file (a menu, a line over a slot) is
 * `agent({ promptContext })`, appended under it.
 *
 * **The filesystem read is deliberately NOT here**, for the reason
 * `tool-registry.ts` gives: the guest sandbox loads one ESM string and has no
 * directory to scan, so the read happens where the bundle is assembled and the
 * text arrives here already loaded.
 */

import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import type { AgentDef } from "./types.ts";

/**
 * Attach a discovered `system-prompt.md` to an agent definition — and the one
 * door a HOST uses to set a prompt of its own on a lowered definition (the
 * studio's coding agent, a runtime spec), since `agent()` refuses the key.
 *
 * Four outcomes, decided by comparing VALUES rather than by reading source:
 *
 * 1. The def carries the framework default — what every `agent()` call
 *    returns — so the file becomes it.
 * 2. The def's prompt is a RESOLVER. Left alone: a host that composes the
 *    whole prompt per session owns it, and there is no text to compare.
 * 3. The def's prompt CONTAINS the file's text: the file was applied already
 *    (a re-lowering — `deployedAgent` over `virtual:aai/agent`'s def). Left
 *    exactly as it is.
 * 4. None of those: a `system-prompt.md` exists and nothing reads it, while
 *    the def carries a different prompt STRING — a raw `export default {...}`
 *    that skipped `agent()`, or a host that set one. That is an ERROR.
 *
 * **Outcome 4 is the whole point of the function.** "I edited
 * `system-prompt.md` and nothing changed" is the silent-absence failure tool
 * discovery was introduced to kill, pointing the other way — and it is worse
 * here, because a prompt is edited far more often than a tool is added, and a
 * prompt that is quietly ignored produces an agent that behaves plausibly and
 * wrongly rather than one that visibly cannot do something.
 *
 * Comparing values is also what makes the question answerable at all: "does
 * anything reference the file?" invites a scrape of source text or a question
 * to the bundler's module graph (unavailable at entry-generation time, since
 * the entry is written before the build). The resolved prompt answers it
 * directly, and outcome 3 needs no special case.
 *
 * **`promptContext` is not part of the comparison.** It is the field for an
 * author who has a file AND a line to add under it — the whole point of it is
 * that the file stays undeclared — so a def carrying one still reaches outcome
 * 1, and the context rides through untouched for `buildSystemPrompt` to append
 * under the file. Folding the context into `systemPrompt` here would make the
 * next comparison (a rebuild, `deployedAgent` over the same def) outcome 3 by
 * accident and `aai build`'s prompt-source report wrong.
 *
 * Generic in the def so a caller gets back the type it passed in —
 * `deployedAgent` (`@alexkroman1/aai/testing`) composes this with the tools
 * lowering beside it, which is generic for the same reason, and a widened
 * `AgentDef` in the middle of that pipeline would throw away a template's own
 * exported workflow types.
 *
 * @internal
 */
export function withSystemPrompt<D extends Pick<AgentDef, "systemPrompt">>(
  def: D,
  prompt: string,
): D {
  const trimmed = prompt.trim();
  if (trimmed === "") {
    throw new Error(
      "system-prompt.md is empty. A file with nothing in it is not a prompt — write one, or delete the file and take the framework default.",
    );
  }
  if (def.systemPrompt === DEFAULT_SYSTEM_PROMPT) return { ...def, systemPrompt: prompt };
  // A RESOLVER, left exactly as the host built it — there is no text to
  // search. See outcome 2 above.
  if (typeof def.systemPrompt === "function") return def;
  if (def.systemPrompt.includes(trimmed)) return def;
  throw new Error(
    "system-prompt.md exists and nothing reads it: the agent definition carries a different `systemPrompt` string. The file IS the prompt — remove the field (an `agent()` call never writes it; a raw `export default {...}` or a host may have), and put text computed beside the file in `promptContext`.",
  );
}
