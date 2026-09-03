// Copyright 2026 the AAI authors. MIT license.
/**
 * Resolve what a template's FILESYSTEM declares — its `tools/` directory and its
 * `system-prompt.md` — the way a BUILD does, for a spec.
 *
 * A tool is registered by existing, and the registration happens where a bundle
 * is assembled — `aai-cli/worker-bundler.ts` enumerates `tools/*.ts` and emits
 * static imports, because the guest sandbox is handed one ESM string and has no
 * directory to scan. A spec has no bundler in its path, so it does the same
 * lowering with Vite's own `import.meta.glob` and hands the result to the same
 * `toolRegistry` the generated entry uses. One set of rules, two ways in.
 *
 * It is deliberately NOT a filesystem scan. `import.meta.glob` keeps every tool
 * module inside VITEST's module graph, where `@alexkroman1/aai` resolves through
 * the `@dev/source` condition to this repo's TypeScript. A `readdir` plus
 * `import(pathToFileURL(...))` would load the same files through Node's
 * resolver instead, giving the tools a second copy of the SDK — so a slot's
 * module-level state would differ between the tool under test and the agent
 * holding it, which is the "two physically distinct copies of React" bug wearing
 * a different hat.
 *
 * The glob is EAGER and covers every template at once, because
 * `import.meta.glob` needs a literal pattern — it is expanded at transform time,
 * so it cannot take a template name as a variable.
 *
 * The prose half is the same idea: `system-prompt.md` BECOMES the agent's system
 * prompt, discovered rather than imported, so a spec validating the config a
 * DEPLOYED agent runs has to resolve it here too — otherwise it validates a
 * prompt no deployment uses.
 */

/// <reference types="vite/client" />

import type { AgentDef } from "@alexkroman1/aai";
import { toolRegistry, withSystemPrompt, withTools } from "@alexkroman1/aai/manifest";

/** Every template's tool modules, eagerly, keyed `../templates/<name>/tools/<tool>.ts`. */
const toolModules = import.meta.glob("../templates/*/tools/*.ts", { eager: true });

/**
 * Every template's `system-prompt.md`, as TEXT.
 *
 * `query: "?raw"` is the glob spelling of the suffix the generated worker entry
 * writes, and `import: "default"` unwraps each module so these are strings
 * rather than namespaces.
 */
const promptFiles = import.meta.glob("../templates/*/system-prompt.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/**
 * The def as a deployed agent sees it: the authored definition plus the tools
 * its own `tools/` directory declares.
 *
 * Pass the template's directory name. A template with no `tools/` directory
 * resolves to the def unchanged, which is the workflow-app case.
 */
export function withTemplateTools(name: string, def: AgentDef): AgentDef {
  const prefix = `../templates/${name}/tools/`;
  const own = Object.fromEntries(
    Object.entries(toolModules).filter(([path]) => path.startsWith(prefix)),
  );
  return withTools(def, toolRegistry(own));
}

/**
 * The def with its discovered system prompt applied, when the template keeps one
 * in a file.
 *
 * A template with no `system-prompt.md` resolves unchanged and runs on
 * `DEFAULT_SYSTEM_PROMPT`, which five deliberately do. A template WITH one gets
 * `withSystemPrompt`'s three rules — so an empty file, or a file the agent
 * ignores while declaring its own prompt, fails here for every template at once.
 */
export function withTemplatePrompt(name: string, def: AgentDef): AgentDef {
  const prompt = promptFiles[`../templates/${name}/system-prompt.md`];
  return prompt === undefined ? def : withSystemPrompt(def, prompt);
}

/**
 * The template names that keep their prompt in a file.
 *
 * Exported so a spec can tell "this template has no `system-prompt.md`" from
 * "the glob stopped resolving" — the second is a gate quietly checking nothing,
 * and it looks identical to the first from the outside.
 */
export const templatePromptFiles: ReadonlySet<string> = new Set(
  Object.keys(promptFiles).map((key) => key.split("/")[2] ?? ""),
);
