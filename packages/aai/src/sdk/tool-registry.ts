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
 * **There is exactly ONE source shape — already-loaded modules — and the one
 * runtime scan is a PRODUCER of it, not a second registry builder.** A spec
 * must use `import.meta.glob` so its tools stay inside VITEST's module graph
 * (through Node's resolver they would get a second copy of the SDK, and a
 * slot's module state would differ between the tool under test and the agent
 * holding it), and the scaffold's `server.mjs` loads the BUILT worker, so the
 * bundler is in its path after all. What is left is a plain Node process
 * serving `agent.ts` directly, which has no bundler and a real directory: that
 * one reads it — `withToolsDir` on `@alexkroman1/aai-runtime`, Node-only and
 * therefore not here — and hands the result straight to `toolRegistry`. A lazy
 * `loadToolModules(loaders)` that took the OTHER shape, a map of thunks, was
 * published and called by nothing and is deleted: a second way to build a
 * registry is how the rules below come to have two behaviours, and every
 * source having to arrive as `path → module` is what prevents it.
 *
 * Every diagnostic names the file, because the failure this replaces was
 * silent: a tool that was never registered simply never reached the model, and
 * the agent could not do the thing with no error anywhere.
 */

import { isRecord } from "./is-record.ts";
import type { ToolInputSchema } from "./schema.ts";
import type { ToolDef } from "./types.ts";

/**
 * The name grammar. Snake_case, leading letter, because the name is what the
 * MODEL calls — providers reject a tool name outside `[a-zA-Z0-9_-]`, and this
 * repo's templates have always spelled them snake_case (Biome's filename
 * convention is overridden for `tools/` for exactly that reason).
 */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Longest name a provider accepts — OpenAI's `^[a-zA-Z0-9_-]{1,64}$`, the
 * strictest of the ones this SDK routes to, and therefore the one that decides.
 *
 * Checked here because the grammar above already is, and half a rule is worse
 * than none: a 70-character file name passed every gate, built, deployed, and
 * was refused when the first turn sent the tool list — a failure whose message
 * comes from a vendor and names neither the file nor the cap.
 */
const TOOL_NAME_MAX = 64;

/**
 * File names that are never a tool, however well-formed.
 *
 * `tools/index.ts` is a barrel somebody wrote out of habit, and there is nothing
 * for it to barrel: the directory IS the registry. Registered rather than
 * refused, it put a tool called `index` — with whatever the barrel happened to
 * default-export — in front of the model.
 */
const NON_TOOL_NAMES = new Set(["index"]);

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
  return (
    isRecord(value) && typeof value.description === "string" && typeof value.execute === "function"
  );
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
    if (NON_TOOL_NAMES.has(name)) {
      throw new Error(
        `${path} is a barrel, and a tools/ file IS a tool — the build enumerates the directory, so there is nothing to re-export and this would put a tool named "${name}" in front of the model. Move shared code out of tools/ (\`../shared.ts\`), or name the file after the tool it declares.`,
      );
    }
    if (name.length > TOOL_NAME_MAX) {
      throw new Error(
        `${path} names a tool of ${name.length} characters, and a provider caps a tool name at ${TOOL_NAME_MAX} — the call would be refused when the tool list is sent, not here. Shorten the file name.`,
      );
    }

    const exported = (module as { default?: unknown } | null)?.default;
    if (exported === undefined) {
      throw new Error(
        `${path} has no default export. A tools/ file default-exports its tool: \`export default tool({ … })\` — and every file in tools/ is one, so a helper this directory shares belongs beside it rather than in it (\`../shared.ts\`).`,
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
 * **It is also the seam every registry NOT assembled by a bundler goes on
 * through.** Two do. `withToolsDir` (`@alexkroman1/aai-runtime`) scans a real
 * directory for a self-hosted process and comes back here. And the studio's own
 * coding agent builds four tool families per turn, every one of them closed
 * over a single session's workspace directory (`aai-guest/studio-agent.ts`) —
 * those cannot be files at all, and this is what makes that honest rather than
 * an exception: a registry resolved from a session instead of from a directory,
 * attached the same way.
 *
 * A name the def ALREADY holds is an error. Through `agent()` that is now
 * unreachable — it returns an empty table and refuses a `tools` argument — so
 * what this catches is a hand-written `export default { … tools: {…} }` that
 * skipped `agent()`, and a second `withTools` over a def that already has one.
 *
 * Structural rather than `AgentDef`, and it hands back what it was given: a
 * caller keeps whatever else its def carries, and nothing this returns is
 * described by a type the caller did not already name.
 *
 * @public
 */
export function withTools<D extends { readonly tools: ToolRegistry }>(
  def: D,
  registry: ToolRegistry,
): D {
  for (const name of Object.keys(registry)) {
    if (def.tools[name] !== undefined) {
      throw new Error(
        `The tool "${name}" is declared twice: once by tools/${name}.ts and once on the agent definition. Remove one — a tool is declared by its file.`,
      );
    }
  }
  return { ...def, tools: { ...def.tools, ...registry } };
}
