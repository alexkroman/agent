// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool discovery for a host that has a FILESYSTEM — the Node half of
 * `toolRegistry`.
 *
 * A tool's name is its file name and nothing else, so registration is
 * discovery rather than a line an author writes: `agent()` refuses a `tools`
 * argument outright, and the type it refuses with names the file to create.
 * The catch is that discovery has to happen SOMEWHERE, and until now the only
 * two places it could were a bundler's: the CLI's generated worker entry
 * enumerates `tools/*.ts` at build time and emits static imports, and a spec
 * reaches the same shape through `import.meta.glob`. A plain Node process
 * self-hosting an agent has neither — so on that one path the idiom was
 * unreachable, and the only way to give a self-hosted agent a tool was to
 * hand-write the very `name → import` map the type error exists to prevent.
 *
 * This is the third source, and it is deliberately the only one that reads a
 * directory. It lives here rather than beside `toolRegistry` in
 * `@alexkroman1/aai` because it is Node-only — `node:fs/promises` and a dynamic
 * `import()` — and that package has to stay loadable in a browser. And it
 * RE-USES `toolRegistry`: the name grammar, the co-located-spec skip, the
 * nested-file error, the default-export checks and the collision message all
 * have exactly one implementation, whoever did the scanning. What is added here
 * is the scan and nothing else.
 *
 * **`.ts` needs no build step.** Node strips types natively (22.18+, and this
 * package requires 24), and a dynamic `import()` of a `.ts` file goes through
 * the same loader a static one does — so a `tools/` directory of TypeScript is
 * read by a running `server.mjs` with no bundler anywhere in the path.
 *
 * See `examples/self-hosted-server`, which is written against this.
 */

import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type ToolModules,
  type ToolRegistry,
  toolRegistry,
  withTools,
} from "@alexkroman1/aai/manifest";
import { isRecord } from "@alexkroman1/aai/utils";

/**
 * What in the directory is a MODULE, which is the one judgement the other two
 * sources make before `toolRegistry` sees anything — their globs are
 * `tools/*.ts`. A `README.md` or a `data.json` beside the tools is not a
 * badly-named tool, so it is skipped here rather than failing the name grammar
 * there; a subdirectory has no extension and drops out the same way, while the
 * FILE inside it does not and reaches the nested-file error.
 */
const MODULE_EXT_RE = /\.(?:m?[jt]s|tsx)$/;

/**
 * Read one directory of tool modules into the `path → module` shape
 * `toolRegistry` checks.
 *
 * **The keys are relative to `dir`, and that is not laziness.** `toolRegistry`
 * derives a tool's name from the segment after the last `tools/` in its key, so
 * an absolute key whose parent directory is not literally named `tools` reads
 * as a NESTED file and fails with an error about a directory layout that is
 * fine. A relative key cannot be wrong about that, and every diagnostic still
 * names the file — which is the whole point of them.
 *
 * Recursive on purpose. A tool dropped into a subdirectory is silently absent
 * from a non-recursive scan, and silence is the failure this whole mechanism
 * exists to replace; read that way it reaches `toolRegistry`'s nested-file
 * error instead, which says where to move it.
 *
 * Sorted, so the schema list handed to the model and the two files a collision
 * names are the same on every host rather than in readdir order.
 */
async function readToolModules(dir: string | URL): Promise<ToolModules> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") {
      throw new Error(
        `No tools directory at ${String(dir)}. A tool is a FILE — create that directory with one \`<the name the model calls>.ts\` per tool — or drop the withToolsDir() call for an agent that has none.`,
        { cause },
      );
    }
    throw cause;
  }

  // Through a path rather than by resolving each name against a base URL: a
  // directory URL without its trailing slash resolves every entry against the
  // PARENT, which is a wrong answer rather than an error.
  const root = dir instanceof URL ? fileURLToPath(dir) : dir;
  const paths = entries.filter((entry) => MODULE_EXT_RE.test(entry)).sort();
  const modules: unknown[] = await Promise.all(
    paths.map((path) => import(pathToFileURL(join(root, path)).href)),
  );
  // The KEY is POSIX-spelled whatever the platform separator is: it is what
  // every diagnostic prints, and it is what `toolRegistry` reads a nested file
  // out of — `sub\y.ts` would land in the name grammar's error instead of the
  // one that says which directory to move the file out of.
  return Object.fromEntries(
    paths.map((path, index) => [path.split(sep).join("/"), modules[index]]),
  );
}

/**
 * Attach the tools in a directory to an agent definition, returning the def to
 * serve.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { createAgentServer, withToolsDir } from "@alexkroman1/aai-runtime";
 *
 * const dir = new URL("./tools/", import.meta.url);
 * const served = await withToolsDir(agent({ name: "Support" }), dir);
 * const server = createAgentServer({ agent: served, env: { ASSEMBLYAI_API_KEY: "…" } });
 * ```
 *
 * Adding a tool is adding a file: `tools/roll_die.ts` default-exporting
 * `tool({ … })` is the tool `roll_die`, and this call is what a self-hosted
 * process runs in place of the enumeration a bundler would have done. Nothing
 * else changes — not `agent.ts`, which takes no `tools` field on any path, and
 * not this line, which names a directory rather than its contents.
 *
 * A MISSING directory throws rather than resolving to no tools. An agent whose
 * tools never reached the model, with no error anywhere, is the exact failure
 * discovery replaced, and a typo'd path is the cheapest way back to it.
 *
 * Async because a directory read is, which is also why it is not part of
 * `toolRegistry`: the generated worker entry has its modules statically
 * imported already, and a promise there would put top-level `await` into a
 * bundle the guest sandbox loads.
 *
 * @public
 */
export async function withToolsDir<D extends { readonly tools: ToolRegistry }>(
  def: D,
  dir: string | URL,
): Promise<D> {
  return withTools(def, toolRegistry(await readToolModules(dir)));
}
