// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDef } from "@alexkroman1/aai";
import { agentToolsToSchemas, toAgentConfig } from "@alexkroman1/aai/manifest";
import { build, type Rollup } from "vite";
import { writeTempHtml } from "./_default-html.ts";
import { type CommandResult, ok } from "./_output.ts";
import { fileExists, validateAgentExport } from "./_utils.ts";

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

export type DirectoryBundleOutput = {
  worker: string;
  clientFiles: Record<string, string>;
  agentConfig: Record<string, unknown>;
};

/**
 * Build agent.ts into worker ESM + extract config.
 *
 * One Vite pass produces the worker bundle (all deps inlined); the AgentDef
 * is then dynamic-imported out of that bundle so we don't need a second pass.
 */
export async function buildAgentBundle(cwd: string): Promise<DirectoryBundleOutput> {
  const { log } = await import("./_ui.ts");

  const [worker, clientFiles] = await Promise.all([buildWorker(cwd), buildClient(cwd)]);

  const agentDef = await evalWorkerBundle(worker, cwd);
  log.step(`Bundling ${agentDef.name}`);

  const config = toAgentConfig(agentDef);
  const toolSchemas = agentToolsToSchemas(agentDef.tools ?? {});
  return { worker, clientFiles, agentConfig: { ...config, toolSchemas } };
}

export async function evalWorkerBundle(code: string, cwd: string): Promise<AgentDef> {
  const evalDir = path.join(cwd, ".aai", "eval");
  await fs.mkdir(evalDir, { recursive: true });
  // Unique filename per call to bypass Node's ESM import cache.
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

async function buildWorker(cwd: string): Promise<string> {
  const agentEntry = path.join(cwd, "agent.ts");
  const base = agentViteBuildBase(agentEntry);

  const result = await build({
    ...base,
    plugins: [
      // Inline .md imports as default-exported strings so templates can
      // `import systemPrompt from "./system-prompt.md"`.
      {
        name: "raw-md",
        transform(code, id) {
          if (id.endsWith(".md")) return `export default ${JSON.stringify(code)}`;
        },
      },
    ],
    build: {
      ...base.build,
      lib: { ...base.build.lib, fileName: "worker" },
      write: false,
      rollupOptions: { output: { entryFileNames: "[name].js" } },
    },
  });

  const output = Array.isArray(result) ? result[0] : (result as Rollup.RollupOutput);
  if (!output) throw new Error("Vite produced no output for agent.ts");
  const chunk = output.output.find((o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry);
  if (!chunk) throw new Error("Vite produced no entry chunk for agent.ts");
  return chunk.code;
}

async function buildClient(cwd: string): Promise<Record<string, string>> {
  if (!(await fileExists(path.join(cwd, "client.tsx")))) return {};

  const clientDir = path.join(cwd, ".aai", "client");
  const cleanupHtml = writeTempHtml(cwd);
  try {
    await build({
      root: cwd,
      base: "./",
      logLevel: "silent",
      build: { outDir: ".aai/client", emptyOutDir: true },
    });
  } finally {
    cleanupHtml();
  }

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
