// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDef } from "aai";
import { agentToolsToSchemas, toAgentConfig } from "aai/manifest";
import { build, type Rollup } from "vite";
import { type CommandResult, ok } from "./_output.ts";
import { fileExists, validateAgentExport } from "./_utils.ts";

/** Shared Vite build base config for agent bundles. */
function agentViteBuildBase(entry: string) {
  return {
    logLevel: "silent" as const,
    build: {
      lib: { entry, formats: ["es" as const] },
      target: "node20" as const,
      minify: false,
      rollupOptions: { output: { entryFileNames: "[name].js" } },
    },
  };
}

/** Output from the bundler: agentConfig + worker ESM + client files. */
export type DirectoryBundleOutput = {
  /** ESM bundle of agent.ts (tool execute functions + hook handlers). */
  worker: string;
  /** Static client files from Vite build. Empty if no client.tsx. */
  clientFiles: Record<string, string>;
  /** Serializable agent config — sent as agentConfig to the server. */
  agentConfig: Record<string, unknown>;
};

/**
 * Bundle an agent directory: build agent.ts into worker ESM + extract config.
 *
 * - agent.ts is the single entry point: `export default agent({...})`
 * - A single Vite build produces the worker ESM (all deps bundled in).
 *   The AgentDef is extracted from that bundle via dynamic import, avoiding a
 *   second build pass.
 */
export async function buildAgentBundle(cwd: string): Promise<DirectoryBundleOutput> {
  const { log } = await import("./_ui.ts");

  // Single Vite build for the worker (all deps bundled in) + client in parallel
  const [worker, clientFiles] = await Promise.all([buildWorker(cwd), buildClient(cwd)]);

  // Extract AgentDef from the worker bundle by eval
  const agentDef = await evalWorkerBundle(worker, cwd);
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
async function buildWorker(cwd: string): Promise<string> {
  const agentEntry = path.join(cwd, "agent.ts");
  const base = agentViteBuildBase(agentEntry);

  const result = await build({
    ...base,
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
      ...base.build,
      lib: { ...base.build.lib, fileName: "worker" },
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
  await build({
    root: cwd,
    base: "./",
    logLevel: "silent",
    build: {
      outDir: ".aai/client",
      emptyOutDir: true,
    },
  });

  // Read built files into memory for deploy payload
  const files: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else {
        files[rel] = await fs.readFile(path.join(dir, entry.name), "utf-8");
      }
    }
  }
  await walk(clientDir, "");
  return files;
}

type BuildData = {
  name: string;
  workerBytes: number;
};

export async function executeBuild(cwd: string): Promise<CommandResult<BuildData>> {
  const { log } = await import("./_ui.ts");
  const bundle = await buildAgentBundle(cwd);
  log.success("Build complete");

  return ok({
    name: bundle.agentConfig.name as string,
    workerBytes: bundle.worker.length,
  });
}

export async function runBuildCommand(cwd: string): Promise<void> {
  await executeBuild(cwd);
}
