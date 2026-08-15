// Copyright 2026 the AAI authors. MIT license.
/**
 * The tool registry: a directory of tool files becoming the map the runtime
 * executes.
 *
 * A tool's NAME is its file name and nothing else — `tools/incident_create.ts`
 * is `incident_create` — so registration is discovery rather than a line an
 * author writes. What this module owns is the half that cannot be a filesystem
 * read: turning a set of `path → module` pairs into a checked registry, and
 * attaching it to an agent.
 *
 * **The filesystem read is deliberately NOT here, and that is the design.**
 * The guest sandbox loads ONE ESM string and has no directory to scan, so
 * discovery has to resolve where a bundle is assembled — the CLI's generated
 * worker entry enumerates `tools/*.ts` at build time and emits static imports,
 * the way eve lowers its `readdir` into an import list so a bundler can follow
 * it. A spec reaches the same shape through `import.meta.glob`. Both hand their
 * result here, so the RULES (what a name may be, what a file must export, what
 * a collision means) have one implementation no matter who did the scanning.
 *
 * **There is exactly ONE source shape — already-loaded modules — and no
 * runtime scan anywhere.** A `readdir` + dynamic `import()` mode was designed
 * for the two loaders that have no bundler, and neither took it: a spec uses
 * `import.meta.glob` so its tools stay inside VITEST's module graph (through
 * Node's resolver they would get a second copy of the SDK, and a slot's module
 * state would differ between the tool under test and the agent holding it), and
 * self-hosting loads the BUILT worker (`scaffold/server.mjs`), so the bundler is
 * in its path after all. A lazy `loadToolModules(loaders)` existed for that
 * mode, published and called by nothing; it is deleted rather than kept as an
 * affordance, because a second way to build a registry is how the rules below
 * come to have two behaviours.
 *
 * Every diagnostic names the file, because the failure this replaces was
 * silent: a tool that was never registered simply never reached the model, and
 * the agent could not do the thing with no error anywhere.
 */

import type { ToolInputSchema } from "./schema.ts";
import type { AgentDef, ToolDef } from "./types.ts";

/**
 * The name grammar. Snake_case, leading letter, because the name is what the
 * MODEL calls — providers reject a tool name outside `[a-zA-Z0-9_-]`, and this
 * repo's templates have always spelled them snake_case (Biome's filename
 * convention is overridden for `tools/` for exactly that reason).
 */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Extensions a tool module may be authored in. */
const MODULE_EXT_RE = /\.(?:m?[jt]s|tsx)$/;

/** A co-located spec is not a tool; `foo.test.ts` would register as `foo.test`. */
const SPEC_RE = /\.(?:test|spec)$/;

/**
 * `path → module namespace`, which is what both sources produce: Vite's
 * `import.meta.glob` (eager) and the static import list the CLI generates.
 */
export type ToolModules = Readonly<Record<string, unknown>>;

/** A checked set of tools, keyed by the name the model calls. */
export type ToolRegistry = Readonly<Record<string, ToolDef<ToolInputSchema>>>;

/**
 * A tool as recognized at RUNTIME, which has to be structural: `tool()` is
 * `return def`, so there is no brand to check. A file exporting something else
 * is the mistake worth naming — under discovery it would otherwise register an
 * object the executor calls `execute` on and fail per turn instead of at build.
 */
function isToolDef(value: unknown): value is ToolDef<ToolInputSchema> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { description?: unknown; execute?: unknown };
  return typeof candidate.description === "string" && typeof candidate.execute === "function";
}

/**
 * The name a path declares, with its extension dropped — NOT yet checked
 * against the grammar, because a co-located spec has to be skipped before its
 * name is judged. `echo.test.ts` is not a badly-named tool; it is not a tool.
 *
 * Paths arrive with whatever prefix their source used — `./tools/x.ts` from a
 * glob, `tools/x.ts` from the generated entry, an absolute path from a scan —
 * so only the part after the last `tools/` segment is read.
 */
function toolNameOf(path: string): string {
  const afterDir = path.split(/(?:^|\/)tools\//).pop() ?? path;
  if (afterDir.includes("/")) {
    throw new Error(
      `${path} is nested inside tools/. A tool's name is its file name, and a nested file has no name a provider would accept — move it to tools/${afterDir.split("/").pop()} or keep it out of tools/.`,
    );
  }
  return afterDir.replace(MODULE_EXT_RE, "");
}

/**
 * Build a checked registry from already-loaded modules.
 *
 * Synchronous, because the caller that matters most — the generated worker
 * entry — has the modules statically imported already, and a `Promise` there
 * would put top-level `await` in a bundle the guest loads.
 *
 * @public
 */
export function toolRegistry(modules: ToolModules): ToolRegistry {
  const registry: Record<string, ToolDef<ToolInputSchema>> = {};
  const sources: Record<string, string> = {};

  for (const [path, module] of Object.entries(modules)) {
    const name = toolNameOf(path);
    if (SPEC_RE.test(name)) continue;
    if (!TOOL_NAME_RE.test(name)) {
      throw new Error(
        `${path} is not a usable tool name. A tools/ file is named for the tool the model calls: lowercase, starting with a letter, words joined by "_" (e.g. tools/incident_create.ts).`,
      );
    }

    const exported = (module as { default?: unknown } | null)?.default;
    if (exported === undefined) {
      throw new Error(
        `${path} has no default export. A tools/ file default-exports its tool: \`export default tool({ … })\`.`,
      );
    }
    if (!isToolDef(exported)) {
      throw new Error(
        `${path} does not default-export a tool. Expected the result of \`tool({ description, execute })\` — a tool needs a string \`description\` and an \`execute\` function.`,
      );
    }

    const already = sources[name];
    if (already !== undefined) {
      throw new Error(
        `Two files declare the tool "${name}": ${already} and ${path}. A tool's name is its file name, so one of them has to be renamed.`,
      );
    }
    sources[name] = path;
    registry[name] = exported;
  }

  return registry;
}

/**
 * Attach a registry to an agent definition, returning the def the runtime runs.
 *
 * A NEW object rather than a mutation: the def a module default-exports is
 * shared (a spec imports the same one the entry does), and a loader quietly
 * rewriting it makes the order of two imports decide what an agent can do.
 *
 * **It is also the seam a NON-file registry goes on through**, which is the one
 * legitimate case left: the studio's own coding agent builds four tool families
 * per turn, every one of them closed over a single session's workspace directory
 * (`aai-guest/studio-agent.ts`). Those cannot be files, and this is what makes
 * that honest rather than an exception — a registry resolved from a session
 * instead of from a directory, attached the same way.
 *
 * A name the def ALREADY holds is an error. Through `agent()` that is now
 * unreachable — it returns an empty table and refuses a `tools` argument — so
 * what this catches is a hand-written `export default { … tools: {…} }` that
 * skipped `agent()`, and a second `withTools` over a def that already has one.
 *
 * @public
 */
export function withTools(def: AgentDef, registry: ToolRegistry): AgentDef {
  for (const name of Object.keys(registry)) {
    if (def.tools[name] !== undefined) {
      throw new Error(
        `The tool "${name}" is declared twice: once by tools/${name}.ts and once on the agent definition. Remove one — a tool is declared by its file.`,
      );
    }
  }
  return { ...def, tools: { ...def.tools, ...registry } };
}
