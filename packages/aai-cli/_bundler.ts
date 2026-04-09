// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { type CommandResult, ok } from "./_output.ts";

export class BundleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BundleError";
  }
}

/** Output from the directory-based bundler (agent.json + tools/*.ts + hooks/*.ts). */
export type DirectoryBundleOutput = {
  manifest: import("@alexkroman1/aai/isolate").Manifest;
  manifestJson: string;
  toolBundles: Record<string, string>; // toolName -> compiled JS
  hookBundles: Record<string, string>; // hookKey -> compiled JS
};

// ── Directory-based bundler (agent.json + tools/*.ts + hooks/*.ts) ───────────

// Hook filenames (kebab-case) -> HookFlags keys (camelCase)
const HOOK_FILENAME_MAP: Record<string, string> = {
  "on-connect": "onConnect",
  "on-disconnect": "onDisconnect",
  "on-user-transcript": "onUserTranscript",
  "on-error": "onError",
};

/**
 * Compile a single TypeScript file with esbuild.
 * Returns the compiled JS as a string.
 */
async function compileFile(filePath: string): Promise<string> {
  const { build: esbuild } = await import("esbuild");
  const result = await esbuild({
    entryPoints: [filePath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
  });

  const output = result.outputFiles[0];
  if (!output) {
    throw new Error(`esbuild produced no output for ${filePath}`);
  }

  return output.text;
}

/**
 * Bundle an agent directory (agent.json + tools/*.ts + hooks/*.ts)
 * into a manifest + compiled handler code.
 */
export async function buildAgentBundle(cwd: string): Promise<DirectoryBundleOutput> {
  const { scanAgentDirectory } = await import("./_scanner.ts");
  const { log } = await import("./_ui.ts");

  const manifest = await scanAgentDirectory(cwd);

  log.step(`Bundling ${manifest.name}`);

  const toolBundles: Record<string, string> = {};
  const hookBundles: Record<string, string> = {};

  // Compile tool handlers
  const toolsDir = path.join(cwd, "tools");
  for (const toolName of Object.keys(manifest.tools)) {
    const filePath = path.join(toolsDir, `${toolName}.ts`);
    toolBundles[toolName] = await compileFile(filePath);
  }

  // Compile hook handlers
  const hooksDir = path.join(cwd, "hooks");
  for (const [kebabName, camelName] of Object.entries(HOOK_FILENAME_MAP)) {
    if (manifest.hooks[camelName as keyof typeof manifest.hooks]) {
      const filePath = path.join(hooksDir, `${kebabName}.ts`);
      hookBundles[camelName] = await compileFile(filePath);
    }
  }

  return {
    manifest,
    manifestJson: JSON.stringify(manifest),
    toolBundles,
    hookBundles,
  };
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
  manifest: { name: string; tools: string[] };
  workerBytes: number;
};

export async function executeBuild(cwd: string): Promise<CommandResult<BuildData>> {
  const { log } = await import("./_ui.ts");
  const bundle = await buildAgentBundle(cwd);
  await buildClient(cwd);
  log.success("Build complete");

  const toolNames = Object.keys(bundle.manifest.tools);
  const totalBytes =
    Object.values(bundle.toolBundles).reduce((sum, code) => sum + code.length, 0) +
    Object.values(bundle.hookBundles).reduce((sum, code) => sum + code.length, 0);

  return ok({
    manifest: { name: bundle.manifest.name, tools: toolNames },
    workerBytes: totalBytes,
  });
}

export async function runBuildCommand(cwd: string): Promise<void> {
  await executeBuild(cwd);
}
