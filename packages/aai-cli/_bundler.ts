// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentDef, isTextAssetPath } from "@alexkroman1/aai";
import { agentToolsToSchemas, toAgentConfig } from "@alexkroman1/aai/manifest";
import { build, type Rollup } from "vite";
import { writeTempHtml } from "./_default-html.ts";
import { type CommandResult, ok } from "./_output.ts";
import { log } from "./_ui.ts";
import { fileExists, validateAgentExport } from "./_utils.ts";

/** Output from the bundler: agentConfig + worker ESM + client files. */
export type DirectoryBundleOutput = {
  /** ESM bundle of agent.ts (tool execute functions + hook handlers). */
  worker: string;
  /** Static client files from Vite build. Empty if no client.tsx. */
  clientFiles: Record<string, string>;
  /** Serializable agent config — sent as agentConfig to the server. */
  agentConfig: Record<string, unknown>;
};

/** Options for worker bundling. */
export type BuildWorkerOptions = {
  /**
   * Minify the worker with esbuild. Deploy builds set this to shrink the
   * upload payload; dev builds stay unminified for readable stack traces.
   */
  minify?: boolean;
};

/**
 * Bundle an agent directory: build agent.ts into worker ESM + extract config.
 *
 * - agent.ts is the single entry point: `export default agent({...})`
 * - A single Vite build produces the worker ESM (all deps bundled in).
 *   The AgentDef is extracted from that bundle via dynamic import, avoiding a
 *   second build pass.
 */
export async function buildAgentBundle(
  cwd: string,
  opts: BuildWorkerOptions = {},
): Promise<DirectoryBundleOutput> {
  // Single Vite build for the worker (all deps bundled in) + client in
  // parallel. The eval only depends on the worker, so chain it onto the
  // worker build instead of making it wait for the client build too.
  const [[worker, agentDef], clientFiles] = await Promise.all([
    buildWorker(cwd, opts).then(async (code) => [code, await evalWorkerBundle(code, cwd)] as const),
    buildClient(cwd),
  ]);
  log.step(`Bundling ${agentDef.name}`);

  const config = toAgentConfig(agentDef);
  const toolSchemas = agentToolsToSchemas(agentDef.tools ?? {});
  const agentConfig: Record<string, unknown> = { ...config, toolSchemas };

  return { worker, clientFiles, agentConfig };
}

/**
 * Write the worker ESM to a temp file and dynamic-import it, returning
 * the AgentDef default export. All dependencies are bundled in, so the
 * file can be evaluated from any directory.
 */
export async function evalWorkerBundle(code: string, cwd: string): Promise<AgentDef> {
  const evalDir = path.join(cwd, ".aai", "eval");
  await fs.mkdir(evalDir, { recursive: true });
  // Use a unique filename per invocation to avoid Node's ESM import cache.
  const tmpPath = path.join(
    evalDir,
    `agent-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  try {
    await fs.writeFile(tmpPath, code);
    const mod = await import(pathToFileURL(tmpPath).href);
    const agentDef = (mod.default ?? mod) as AgentDef;

    validateAgentExport(agentDef);
    return agentDef;
  } finally {
    await fs.rm(tmpPath).catch(() => {
      /* best-effort cleanup */
    });
  }
}

/**
 * Bundle agent.ts into a single ESM string for the sandbox worker.
 *
 * Zod is bundled in — zod 4's `Function()` usage is wrapped in try/catch
 * and gracefully degrades in restricted environments like Deno.
 */
export async function buildWorker(cwd: string, opts: BuildWorkerOptions = {}): Promise<string> {
  const agentEntry = path.join(cwd, "agent.ts");

  const result = await build({
    logLevel: "silent",
    plugins: [
      // Transform .md imports into raw string exports so templates that do
      // `import systemPrompt from "./system-prompt.md"` bundle correctly.
      {
        name: "raw-md",
        transform(code, id) {
          if (id.endsWith(".md")) {
            return `export default ${JSON.stringify(code)}`;
          }
        },
      },
    ],
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

/**
 * Build the client SPA using Vite if client.tsx exists.
 * Returns a map of relative file paths to string contents for deploy.
 */
async function buildClient(cwd: string): Promise<Record<string, string>> {
  const clientEntry = path.join(cwd, "client.tsx");
  if (!(await fileExists(clientEntry))) {
    return {}; // No client.tsx — skip client build
  }

  const clientDir = path.join(cwd, ".aai", "client");
  const cleanupHtml = writeTempHtml(cwd);
  try {
    await build({
      root: cwd,
      base: "./",
      logLevel: "silent",
      build: {
        outDir: ".aai/client",
        emptyOutDir: true,
      },
    });
  } finally {
    cleanupHtml();
  }

  // Read built files into memory for deploy payload
  const files: Record<string, string> = {};
  const entries = await fs.readdir(clientDir, { recursive: true, withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const abs = path.join(entry.parentPath, entry.name);
        const rel = path.relative(clientDir, abs).split(path.sep).join("/");
        // Text assets travel as UTF-8; binary assets (images, fonts, wasm)
        // would be corrupted by UTF-8 decode, so base64-encode them. The
        // server serve path decodes using the same isTextAssetPath heuristic.
        files[rel] = isTextAssetPath(rel)
          ? await fs.readFile(abs, "utf-8")
          : (await fs.readFile(abs)).toString("base64");
      }),
  );
  return files;
}

type BuildData = {
  name: string;
  workerBytes: number;
};

export async function executeBuild(cwd: string): Promise<CommandResult<BuildData>> {
  // `aai build` previews the deploy artifact, so build it exactly like deploy.
  const bundle = await buildAgentBundle(cwd, { minify: true });
  log.success("Build complete");

  return ok({
    name: bundle.agentConfig.name as string,
    workerBytes: bundle.worker.length,
  });
}
