// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { build, type Rollup } from "vite";
import { resolveAgentConfig } from "./_agent-config.ts";
import { type CommandResult, ok } from "./_output.ts";

/** Output from the bundler: agent.json (verbatim) + Vite output of tools.ts. */
export type DirectoryBundleOutput = {
  /** ESM bundle of tools.ts (tool execute functions + hook handlers). */
  worker: string;
  /** Static client files from Vite build. Empty if no client.tsx. */
  clientFiles: Record<string, string>;
  /** agent.json contents — sent verbatim as agentConfig to the server. */
  agentConfig: Record<string, unknown>;
};

/**
 * Bundle an agent directory: read agent.json + Vite-bundle tools.ts.
 *
 * - agent.json is the declarative config (name, systemPrompt, toolSchemas, etc.)
 *   and is sent verbatim to the server as agentConfig.
 * - tools.ts is the code entry point (exports tool functions + hooks)
 *   and is bundled into a single ESM worker string via Vite library mode.
 */
export async function buildAgentBundle(cwd: string): Promise<DirectoryBundleOutput> {
  const { log } = await import("./_ui.ts");

  const agentConfig = await resolveAgentConfig(cwd);
  log.step(`Bundling ${agentConfig.name}`);

  // ── Bundle tools.ts with Vite library mode ─────────────────────────────
  const toolsEntry = path.join(cwd, "tools.ts");
  let worker = "";
  try {
    await fs.access(toolsEntry);
    const result = await build({
      logLevel: "silent",
      build: {
        lib: { entry: toolsEntry, formats: ["es"], fileName: "worker" },
        write: false,
        target: "node20",
        minify: false,
        rollupOptions: {
          output: { entryFileNames: "[name].js" },
        },
      },
    });
    // Vite returns RollupOutput or RollupOutput[] — we expect a single output
    const output = Array.isArray(result) ? result[0] : (result as Rollup.RollupOutput);
    if (!output) throw new Error("Vite produced no output for tools.ts");
    const chunk = output.output.find(
      (o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry,
    );
    if (!chunk) throw new Error("Vite produced no entry chunk for tools.ts");
    worker = chunk.code;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No tools.ts — agent has no custom tools/hooks, just builtins
      worker = "export const tools = {}; export const hooks = {};";
    } else {
      throw err;
    }
  }

  return { worker, clientFiles: {}, agentConfig };
}

/**
 * Build the client SPA using Vite if client.tsx exists.
 * Outputs to .aai/client/ for static serving.
 */
async function buildClient(cwd: string): Promise<void> {
  const clientEntry = path.join(cwd, "client.tsx");
  try {
    await fs.access(clientEntry);
  } catch {
    return; // No client.tsx — skip client build
  }

  const clientDir = path.join(cwd, ".aai", "client");
  await build({
    root: cwd,
    base: "./",
    logLevel: "warn",
    build: {
      outDir: clientDir,
      emptyOutDir: true,
    },
  });
}

type BuildData = {
  name: string;
  workerBytes: number;
};

export async function executeBuild(cwd: string): Promise<CommandResult<BuildData>> {
  const { log } = await import("./_ui.ts");
  const [bundle] = await Promise.all([buildAgentBundle(cwd), buildClient(cwd)]);
  log.success("Build complete");

  return ok({
    name: bundle.agentConfig.name as string,
    workerBytes: bundle.worker.length,
  });
}

export async function runBuildCommand(cwd: string): Promise<void> {
  await executeBuild(cwd);
}
