// Copyright 2026 the AAI authors. MIT license.
/**
 * `virtual:aai/agent` — the agent as DEPLOYED, without the spec restating the
 * build.
 *
 * A spec that wants what `aai build` produces has had to reconstruct it by
 * hand, because two of the three inputs are literals Vite must see at the call
 * site:
 *
 * ```ts no-check
 * import { deployedAgent } from "@alexkroman1/aai/testing";
 * import authoredAgent from "./agent.ts";
 * import systemPrompt from "./system-prompt.md?raw";
 *
 * const agentDef = deployedAgent(authoredAgent, {
 *   tools: import.meta.glob("./tools/*.ts", { eager: true }),
 *   systemPrompt,
 * });
 * ```
 *
 * Six lines, in every spec of every agent, whose entire content is "give me the
 * agent as deployed" — and three concepts (a glob with an `eager` flag, a `?raw`
 * suffix, a lowering function) that exist only because the spec is standing
 * outside the build looking in. Measured across the shipped templates before
 * this: 25 files, ~125 lines, plus a `/// <reference types="vite/client" />`
 * apiece to make the glob type-check.
 *
 * A plugin is standing INSIDE the build, so it can just do it:
 *
 * ```ts
 * import agentDef from "virtual:aai/agent";
 * ```
 *
 * ## Why it enumerates rather than emitting a glob
 *
 * The generated module could contain `import.meta.glob` and let Vite expand it,
 * which is fewer lines here and a worse mechanism: glob expansion runs in
 * `vite:import-analysis`, so whether it fires in a virtual module depends on
 * plugin ordering, and the failure mode is an empty tool set — an agent that
 * silently has no tools, which is the exact failure `tool-registry.ts` exists
 * to prevent. Reading the directory and emitting one static import per file is
 * deterministic, and a missing `tools/` directory is then a plain empty object
 * rather than a glob that matched nothing.
 *
 * ## What it does not do
 *
 * It resolves against the IMPORTER's directory, so a spec anywhere in the
 * project gets its own agent, and it does not look upward: a spec beside no
 * `agent.ts` is an error naming the directory it looked in, rather than a
 * silent climb to some other agent's.
 *
 * ## Why it lives in `host/`
 *
 * It reads a directory, and `sdk/` is checked by a program with `types: []` and
 * no Node lib — deliberately, so everything there stays isomorphic. A module
 * that calls `readdirSync` belongs on the other side of that line.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** The module specifier a spec imports. */
export const AAI_AGENT_MODULE = "virtual:aai/agent";

/**
 * The minimal Vite plugin shape, declared structurally.
 *
 * `vite` is not a dependency of this package and must not become one — it is
 * the base of the workspace's dependency graph. A plugin is a plain object, so
 * the contract can be spelled out instead of imported; Vite accepts it because
 * this is what its own `Plugin` type resolves to for these three hooks.
 *
 * @public
 */
export type AaiVitePlugin = {
  readonly name: string;
  readonly enforce: "pre";
  resolveId(id: string, importer?: string): string | undefined;
  load(id: string): string | undefined;
};

/** Marks the resolved id as virtual, per Vite's convention. */
const RESOLVED = "\0aai-agent:";

/**
 * Serve {@link AAI_AGENT_MODULE} for the agent project a spec sits in.
 *
 * Register it in `vitest.config.ts`; the scaffold does so already, so an
 * `aai init` project needs nothing.
 *
 * ```ts
 * import { aaiAgentPlugin } from "@alexkroman1/aai/testing/vite";
 * import { defineConfig } from "vitest/config";
 *
 * export default defineConfig({ plugins: [aaiAgentPlugin()], test: { globals: true } });
 * ```
 *
 * @public
 */
export function aaiAgentPlugin(): AaiVitePlugin {
  return {
    name: "aai:agent",
    // BEFORE `vite:resolve`, so the bare `virtual:` specifier is claimed here
    // rather than reported as a missing package.
    enforce: "pre",
    resolveId(id, importer) {
      if (id !== AAI_AGENT_MODULE) return;
      if (importer === undefined) {
        throw new Error(
          `${AAI_AGENT_MODULE} was requested with no importer, so there is no agent directory to resolve it against. Import it from a spec inside the agent's own directory.`,
        );
      }
      return RESOLVED + dirname(importer);
    },
    load(id) {
      if (!id.startsWith(RESOLVED)) return;
      return generate(id.slice(RESOLVED.length));
    },
  };
}

/** The module source for the agent project rooted at `dir`. */
function generate(dir: string): string {
  const agent = join(dir, "agent.ts");
  if (!existsSync(agent)) {
    throw new Error(
      `${AAI_AGENT_MODULE} found no agent.ts in ${dir}. It resolves against the importing file's own directory and deliberately does not search upward, so a spec belongs beside the agent it tests.`,
    );
  }
  const lines = [
    'import { deployedAgent } from "@alexkroman1/aai/testing";',
    `import authored from ${JSON.stringify(agent)};`,
  ];
  const tools = toolFiles(dir);
  for (const [i, file] of tools.entries()) {
    lines.push(`import * as tool${i} from ${JSON.stringify(file)};`);
  }
  const prompt = join(dir, "system-prompt.md");
  const hasPrompt = existsSync(prompt);
  if (hasPrompt) lines.push(`import systemPrompt from ${JSON.stringify(`${prompt}?raw`)};`);

  const entries = tools.map((file, i) => `  [${JSON.stringify(file)}]: tool${i},`).join("\n");
  lines.push(
    "",
    `const tools = {\n${entries}\n};`,
    "",
    // `deployedAgent` refuses an EMPTY tools glob, because a glob that matched
    // nothing means a broken pattern. Here an empty directory is a fact, not a
    // typo, so the key is omitted rather than passed empty.
    "export default deployedAgent(authored, {",
    ...(tools.length > 0 ? ["  tools,"] : []),
    ...(hasPrompt ? ["  systemPrompt,"] : []),
    "});",
    "",
  );
  return lines.join("\n");
}

/** Every `tools/*.ts` file that is a tool — specs and type tests are not. */
function toolFiles(dir: string): string[] {
  const root = join(dir, "tools");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".ts") && !/\.(test|test-d)\.ts$/.test(name))
    .sort()
    .map((name) => join(root, name));
}
