// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDef } from "aai";
import { agentToolsToSchemas, toAgentConfig } from "aai/manifest";
import { build, type Rollup } from "vite";
import { type CommandResult, ok } from "./_output.ts";
import { fileExists } from "./_utils.ts";

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
 * Build agent.ts into a temp ESM module, dynamic-import it, and return
 * the AgentDef default export.
 *
 * Vite builds agent.ts with `aai` and `zod` externalized so the real
 * installed packages are used at eval time.
 */
export async function loadAgentModule(cwd: string): Promise<AgentDef> {
  const agentEntry = path.join(cwd, "agent.ts");

  // Build agent.ts into a temp directory for dynamic import
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_eval_"));
  try {
    const base = agentViteBuildBase(agentEntry);
    try {
      await build({
        ...base,
        build: {
          ...base.build,
          lib: { ...base.build.lib, fileName: "agent" },
          outDir: tmpDir,
          write: true,
          rollupOptions: {
            // Externalize aai and zod so the real installed packages are used
            external: [/^aai/, /^zod/],
            output: { entryFileNames: "[name].js" },
          },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT")) throw new Error(`Missing agent.ts in ${cwd}`, { cause: err });
      throw err;
    }

    const builtPath = path.join(tmpDir, "agent.js");
    const mod = await import(pathToFileURL(builtPath).href);
    const agentDef = (mod.default ?? mod) as AgentDef;

    if (!agentDef.name || typeof agentDef.name !== "string") {
      throw new Error("agent.ts must export a default with a name field");
    }

    return agentDef;
  } finally {
    await fs.rm(tmpDir, { recursive: true }).catch(() => {
      /* best-effort cleanup */
    });
  }
}

/**
 * Bundle an agent directory: build agent.ts into worker ESM + extract config.
 *
 * - agent.ts is the single entry point: `export default agent({...})`
 * - The bundler extracts the AgentDef, converts it to serializable agentConfig
 *   (with tool schemas as JSON Schema), and also bundles agent.ts into a
 *   worker ESM string for the sandbox.
 */
export async function buildAgentBundle(cwd: string): Promise<DirectoryBundleOutput> {
  const { log } = await import("./_ui.ts");

  // Step 1: Load agent.ts to extract the AgentDef
  const agentDef = await loadAgentModule(cwd);
  log.step(`Bundling ${agentDef.name}`);

  // Step 2: Extract serializable config + tool schemas
  const config = toAgentConfig(agentDef);
  const toolSchemas = agentToolsToSchemas(agentDef.tools ?? {});
  const agentConfig: Record<string, unknown> = { ...config, toolSchemas };

  // Step 3+4: Bundle worker + client in parallel
  const [worker, clientFiles] = await Promise.all([buildWorker(cwd), buildClient(cwd)]);

  return { worker, clientFiles, agentConfig };
}

/**
 * Bundle agent.ts into a single ESM string for the sandbox worker.
 *
 * Zod is externalized because it uses `Function()` which fails in the
 * Deno sandbox. Tool schemas are extracted at build time — Zod is not
 * needed at runtime in the sandbox.
 */
async function buildWorker(cwd: string): Promise<string> {
  const agentEntry = path.join(cwd, "agent.ts");
  const base = agentViteBuildBase(agentEntry);

  const result = await build({
    ...base,
    build: {
      ...base.build,
      lib: { ...base.build.lib, fileName: "worker" },
      write: false,
      rollupOptions: {
        // Externalize zod — it uses Function() which fails in the Deno sandbox
        external: [/^zod/],
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
