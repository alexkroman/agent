// Copyright 2025 the AAI authors. MIT license.

/**
 * Worker bundling — the one implementation of "turn an `agent.ts` into the
 * ESM the guest sandbox loads".
 *
 * Public (no `_` prefix) for the same reason as `client-bundler.ts`: the
 * platform's browser studio builds its workspaces through this function, so a
 * worker published from the browser comes out of the same Vite/Rollup pass as
 * one from `aai deploy`.
 *
 * What the studio supplies via options, because a workspace is not a project:
 *
 * - **`root` + `entry`.** The studio builds a generated entry that re-exports
 *   the agent *and* its extracted config, so the guest can report the config
 *   back without the host ever evaluating agent code.
 * - **`configFile: false`.** Workspace files are untrusted and a Vite config
 *   is executable host code.
 * - **`plugins`.** The studio adds its import allowlist; without it, Vite
 *   would happily resolve any package in the server's `node_modules`.
 */

import path from "node:path";
import { build, type PluginOption, type Rollup } from "vite";

/** Options for worker bundling. */
export type BuildWorkerOptions = {
  /**
   * Minify the worker with esbuild. Deploy builds set this to shrink the
   * upload payload; dev builds stay unminified for readable stack traces.
   */
  minify?: boolean;
  /** Entry module, absolute or relative to `cwd`. Defaults to `agent.ts`. */
  entry?: string;
  /** `false` ignores any `vite.config.ts` under `cwd` (see module doc). */
  configFile?: false;
  /** Extra plugins, appended after the built-in `.md` raw loader. */
  plugins?: PluginOption[];
};

/**
 * Transform `.md` imports into raw string exports so templates that do
 * `import systemPrompt from "./system-prompt.md"` bundle correctly.
 */
const rawMdPlugin: PluginOption = {
  name: "raw-md",
  transform(code: string, id: string) {
    if (id.endsWith(".md")) {
      return `export default ${JSON.stringify(code)}`;
    }
  },
};

/**
 * Bundle agent.ts into a single ESM string for the sandbox worker.
 *
 * Zod is bundled in — zod 4's `Function()` usage is wrapped in try/catch
 * and gracefully degrades in restricted environments like Deno.
 */
export async function buildWorker(cwd: string, opts: BuildWorkerOptions = {}): Promise<string> {
  const entry = opts.entry ?? "agent.ts";
  const agentEntry = path.isAbsolute(entry) ? entry : path.join(cwd, entry);

  const result = await build({
    root: cwd,
    logLevel: "silent",
    ...(opts.configFile === false && { configFile: false }),
    plugins: [rawMdPlugin, ...(opts.plugins ?? [])],
    build: {
      lib: { entry: agentEntry, formats: ["es"], fileName: "worker" },
      target: "node20",
      minify: opts.minify ? "esbuild" : false,
      write: false,
      rollupOptions: {
        output: { entryFileNames: "[name].js" },
      },
    },
  });

  const output = Array.isArray(result) ? result[0] : (result as Rollup.RollupOutput);
  if (!output) throw new Error("Vite produced no output for agent.ts");
  const chunk = output.output.find((o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry);
  if (!chunk) throw new Error("Vite produced no entry chunk for agent.ts");
  return chunk.code;
}
