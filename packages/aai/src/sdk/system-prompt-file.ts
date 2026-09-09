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
 *
 * ## The file reaches a RESOLVER by the same import a composed string uses
 *
 * `AgentDef.systemPrompt` takes `string | ((ctx: AgentSessionContext) => string)`
 * (`agent-instructions.ts`), and a resolver is how an agent puts live session
 * state in front of the model without spending a tool call on it. There is
 * exactly one way for the file to reach one, and it is the one an author already
 * uses to compose a STRING out of it: `import prompt from
 * "./system-prompt.md?raw"` in `agent.ts`, closed over by the function. The
 * worked example is on `AgentSystemPrompt` — the type an author reads — and
 * `text-adventure-agent` and `tabletop-rpg-agent` are the shipped ones.
 *
 * One documented route in, not two: the `?raw` suffix is already what the
 * composed-string case takes, already type-checks under the scaffold's
 * `vite/client` reference, and already ships in four templates. A second
 * mechanism — this function partially applying the file into the resolver's
 * arguments — would read better in the one project that has a file and hand
 * `undefined` to every project that does not, since nothing calls this function
 * when there is no file to attach.
 */

import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import type { AgentDef } from "./types.ts";

/**
 * Attach a discovered `system-prompt.md` to an agent definition.
 *
 * Four outcomes, decided by comparing VALUES rather than by reading source:
 *
 * 1. The def carries the framework default — the author declared no
 *    `systemPrompt` — so the file becomes it.
 * 2. The def's prompt is a RESOLVER. Left alone: see below.
 * 3. The def's prompt CONTAINS the file's text: the author imported it, either
 *    verbatim or composed with more around it (a menu, a computed suffix). Left
 *    exactly as the author built it.
 * 4. None of those: a `system-prompt.md` exists and nothing reads it, while the
 *    agent declares a different prompt STRING. That is an ERROR.
 *
 * **Outcome 4 is the whole point of the function.** "I edited
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
 * **Outcome 2 is where that method runs out, and refusing was the wrong
 * answer.** A resolver's text does not exist yet — it is computed per request
 * from a live session — so there is no value to search for the file's contents
 * in, and the check outcome 4 performs is simply undecidable for a function.
 * This used to throw, which cost the whole capability rather than buying
 * anything: 20 of the 29 shipped templates keep a `system-prompt.md`, so
 * dynamic instructions were unreachable from every real agent, and the remedy
 * the error suggested (import the file and compose it) produced another
 * function and threw again. What replaces the check is ownership — an author
 * who wrote a function has taken over composing the prompt, and the file
 * reaches it through the closure shown in this module's header.
 *
 * Outcome 1 cannot rescue a resolver either, and for a reason worth stating: a
 * function is never the framework default, so outcome 1's `===` can only ever
 * match a string. Every resolver reaches outcome 2, which is why that arm has
 * to be a decision rather than a fallthrough.
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
  // A RESOLVER, left exactly as the author built it — there is no text to
  // search, and composing the file into one is the author's job (they may
  // already have imported it). See outcome 2 above.
  if (typeof def.systemPrompt === "function") return def;
  if (def.systemPrompt.includes(trimmed)) return def;
  throw new Error(
    'system-prompt.md exists and nothing reads it: agent.ts declares a different `systemPrompt` string. Either remove the field and let the file be the prompt, or import the file and build your prompt out of it — `import prompt from "./system-prompt.md?raw"`, then interpolate it into the string, or write `systemPrompt: (ctx) => ...` closing over it if the prompt has to see the live session.',
  );
}
