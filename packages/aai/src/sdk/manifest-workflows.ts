// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow registry: a `workflows/` directory becoming entries of
 * `agent({ workflows })`, the way `tool-registry.ts` turns `tools/` into
 * `agent({ tools })`.
 *
 * A workflow has always been registered by the key it is declared under in
 * `agent({ workflows })`, and that stays the declaration of record. What this
 * adds is the other way in: a `workflows/<name>.ts` whose DEFAULT export is a
 * `workflow()` def is registered as `<name>` with nothing written in
 * `agent.ts`. The two compose — a name declared explicitly WINS over a file
 * of the same name, with a warning naming both, so moving a declaration out
 * of `agent.ts` is a deletion there and nothing else, and an app that lists
 * one workflow explicitly and keeps three more as files gets all four.
 *
 * **The filesystem read is deliberately NOT here**, for `tool-registry.ts`'s
 * reason: the guest sandbox loads one ESM string and has no directory to scan,
 * so discovery happens where the bundle is assembled — the CLI's generated
 * worker entry enumerates `workflows/*.ts` and emits static imports, and
 * `virtual:aai/agent` does the same for a spec. Both hand `path → module`
 * pairs here, so what counts as a workflow file has ONE implementation.
 *
 * ## What is NOT a workflow file, and is skipped rather than refused
 *
 * `workflows/` has always been the directory a workflow's BODY lives in, and a
 * body's helpers live beside it — `workflows/prompts.ts`, `workflows/media.ts`,
 * a `workflows/tokens.ts` of token builders — none of which default-export a
 * def. Refusing those, as `toolRegistry` refuses a `tools/` file that is not a
 * tool, would break every project that already has a `workflows/` directory.
 * So a module with no default export, or whose default export is not a def
 * (no `run` function), is simply not a workflow. Only a file that IS one and is
 * misnamed is an error, because that one is a workflow the author meant to
 * register and cannot.
 */

import { isRecord } from "./is-record.ts";
import type { WorkflowDef } from "./workflow.ts";

/**
 * The name grammar: what `agent({ workflows })` keys and the workflow API's
 * `:name` segment already accept, so a file name becomes a name without
 * translation. A leading letter, then letters, digits, `_` and `-`.
 */
const WORKFLOW_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Longest name registered — a path segment of the workflow API. */
const WORKFLOW_NAME_MAX = 64;

/** Extensions a workflow module may be authored in. */
const MODULE_EXT_RE = /\.(?:m?[jt]s|tsx)$/;

/** A co-located spec or type test is never a workflow file. */
const SPEC_RE = /\.(?:test|spec|test-d)$/;

/**
 * `path → module namespace`, as both sources produce it: the static import
 * list the CLI generates, and a spec's `import.meta.glob` (eager).
 *
 * @public
 */
export type WorkflowModules = Readonly<Record<string, unknown>>;

/** A checked set of workflows, keyed by the name they are started under. */
export type WorkflowRegistry = Readonly<Record<string, WorkflowDef>>;

/**
 * A workflow def as recognized at RUNTIME — structural, because `workflow()`
 * returns its argument and there is no brand to read. `run` is the one member
 * every def has.
 */
function isWorkflowDef(value: unknown): value is WorkflowDef {
  return isRecord(value) && typeof value.run === "function";
}

/** The name a path declares: the file name after the last `workflows/`, extension dropped. */
function workflowNameOf(path: string): { name: string; nested: boolean } {
  const afterDir = path.split(/(?:^|\/)workflows\//).pop() ?? path;
  return { name: afterDir.replace(MODULE_EXT_RE, ""), nested: afterDir.includes("/") };
}

/**
 * The workflows a `workflows/` directory declares, from its already-loaded
 * modules. Synchronous, like `toolRegistry`, so the generated entry carries no
 * top-level `await`.
 *
 * A module that does not default-export a def is skipped (see the module
 * doc). One that does and is nested, misnamed or a duplicate is an error
 * naming the file.
 *
 * @public
 */
export function workflowRegistry(modules: WorkflowModules): WorkflowRegistry {
  const registry: Record<string, WorkflowDef> = {};
  const sources: Record<string, string> = {};
  for (const [path, module] of Object.entries(modules)) {
    const { name, nested } = workflowNameOf(path);
    if (SPEC_RE.test(name)) continue;
    const exported = (module as { default?: unknown } | null)?.default;
    if (!isWorkflowDef(exported)) continue;
    if (nested) {
      throw new Error(
        `${path} default-exports a workflow but is nested inside workflows/. A workflow's name is its file name, so move it to workflows/${name.split("/").pop()}.ts or register it in agent({ workflows }).`,
      );
    }
    if (!WORKFLOW_NAME_RE.test(name) || name.length > WORKFLOW_NAME_MAX) {
      throw new Error(
        `${path} default-exports a workflow, but "${name}" is not a usable workflow name: a letter, then up to ${WORKFLOW_NAME_MAX} letters, digits, "_" or "-" (e.g. workflows/digest.ts). Rename the file, or register the def under a name in agent({ workflows }).`,
      );
    }
    const already = sources[name];
    if (already !== undefined) {
      throw new Error(
        `Two files declare the workflow "${name}": ${already} and ${path}. A workflow's name is its file name, so one of them has to be renamed.`,
      );
    }
    sources[name] = path;
    registry[name] = exported;
  }
  return registry;
}

/**
 * What {@link withWorkflows} may be told.
 *
 * @input
 */
export type WithWorkflowsOptions = {
  /**
   * Where a name-clash warning goes. Default `console.warn`, which under
   * `aai build` and `aai dev` reaches the terminal; the studio passes its own.
   */
  warn?: ((message: string) => void) | undefined;
};

/**
 * Attach a discovered registry to an agent definition, returning the def the
 * runtime runs — a NEW object, for `withTools`' reason (the def a module
 * exports is shared with every spec that imports it).
 *
 * **An explicit declaration wins a clash, and says so.** `withTools` refuses a
 * name declared twice, because a tool's file IS its declaration and a second
 * one is a contradiction. A workflow's declaration of record is still
 * `agent({ workflows })`, and the common clash is benign — the author
 * registered `workflows/digest.ts`'s def as `digest` and the file ALSO
 * default-exports it, which is the same object under the same name. That case
 * is silent. A DIFFERENT def under a declared name keeps the declared one and
 * warns, naming the file, so the file's author learns it is not the one
 * running rather than discovering it from a run that behaves like the other.
 *
 * Structural rather than `AgentDef`, and it hands back what it was given, as
 * `withTools` does.
 *
 * @public
 */
export function withWorkflows<D extends object>(
  def: D,
  registry: WorkflowRegistry,
  options: WithWorkflowsOptions = {},
): D {
  // `D extends object` rather than a `{ workflows?: … }` bound: an all-optional
  // bound is a WEAK type, which a def with no `workflows` key (every voice
  // agent's) fails to satisfy for having nothing in common with it.
  const declared = (def as { readonly workflows?: WorkflowRegistry | undefined }).workflows ?? {};
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const merged: Record<string, WorkflowDef> = { ...declared };
  for (const [name, discovered] of Object.entries(registry)) {
    const explicit = declared[name];
    if (explicit === undefined) {
      merged[name] = discovered;
    } else if (explicit !== discovered) {
      warn(
        `workflows/${name}.ts default-exports a workflow, but agent({ workflows }) declares a different "${name}". The declared one runs; the file's default export is ignored. Remove one of them.`,
      );
    }
  }
  if (Object.keys(merged).length === 0) return def;
  return { ...def, workflows: merged };
}
