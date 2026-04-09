// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { type CommandResult, ok } from "./_output.ts";

/** Output from the bundler: agent.json (verbatim) + esbuild output of tools.ts. */
export type DirectoryBundleOutput = {
  /** ESM bundle of tools.ts (tool execute functions + hook handlers). */
  worker: string;
  /** Static client files from Vite build. Empty if no client.tsx. */
  clientFiles: Record<string, string>;
  /** agent.json contents — sent verbatim as agentConfig to the server. */
  agentConfig: Record<string, unknown>;
};

/**
 * Bundle an agent directory: read agent.json + esbuild tools.ts.
 *
 * - agent.json is the declarative config (name, systemPrompt, toolSchemas, etc.)
 *   and is sent verbatim to the server as agentConfig.
 * - tools.ts is the code entry point (exports tool functions + hooks)
 *   and is bundled into a single ESM worker string.
 */
export async function buildAgentBundle(cwd: string): Promise<DirectoryBundleOutput> {
  const { log } = await import("./_ui.ts");

  // ── Read agent.json ────────────────────────────────────────────────────
  const agentJsonPath = path.join(cwd, "agent.json");
  let agentConfig: Record<string, unknown>;
  try {
    agentConfig = JSON.parse(await fs.readFile(agentJsonPath, "utf-8"));
  } catch (err) {
    throw new Error(`Missing agent.json in ${cwd}`, { cause: err });
  }

  if (!agentConfig.name || typeof agentConfig.name !== "string") {
    throw new Error("agent.json must have a name field");
  }

  log.step(`Bundling ${agentConfig.name}`);

  // ── Bundle tools.ts with esbuild ───────────────────────────────────────
  const toolsEntry = path.join(cwd, "tools.ts");
  let worker = "";
  try {
    await fs.access(toolsEntry);
    const { build: esbuild } = await import("esbuild");
    const result = await esbuild({
      entryPoints: [toolsEntry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      target: "node20",
    });
    const output = result.outputFiles[0];
    if (!output) throw new Error("esbuild produced no output for tools.ts");
    worker = output.text;
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
  const bundle = await buildAgentBundle(cwd);
  await buildClient(cwd);
  log.success("Build complete");

  return ok({
    name: bundle.agentConfig.name as string,
    workerBytes: bundle.worker.length,
  });
}

export async function runBuildCommand(cwd: string): Promise<void> {
  await executeBuild(cwd);
}
