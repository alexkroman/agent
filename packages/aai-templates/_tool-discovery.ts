// Copyright 2026 the AAI authors. MIT license.
/**
 * Resolve a template's `tools/` directory the way a BUILD does, for a spec.
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
 */

/// <reference types="vite/client" />

import type { AgentDef } from "@alexkroman1/aai";
import { toolRegistry, withTools } from "@alexkroman1/aai/manifest";

/** Every template's tool modules, eagerly, keyed `./templates/<name>/tools/<tool>.ts`. */
const toolModules = import.meta.glob("./templates/*/tools/*.ts", { eager: true });

/**
 * The def as a deployed agent sees it: the authored definition plus the tools
 * its own `tools/` directory declares.
 *
 * Pass the template's directory name. A template with no `tools/` directory
 * resolves to the def unchanged, which is the workflow-app case.
 */
export function withTemplateTools<S>(name: string, def: AgentDef<S>): AgentDef<S> {
  const prefix = `./templates/${name}/tools/`;
  const own = Object.fromEntries(
    Object.entries(toolModules).filter(([path]) => path.startsWith(prefix)),
  );
  return withTools(def, toolRegistry<S>(own));
}
