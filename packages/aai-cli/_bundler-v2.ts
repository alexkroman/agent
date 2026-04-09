// Copyright 2025 the AAI authors. MIT license.
/**
 * esbuild-based bundler for directory-format agents.
 *
 * Scans an agent directory (agent.json + tools/*.ts + hooks/*.ts),
 * compiles each handler with esbuild, and returns the manifest +
 * compiled JS bundles.
 */

import path from "node:path";
import type { Manifest } from "@alexkroman1/aai/isolate";
import { build } from "esbuild";
import { scanAgentDirectory } from "./_scanner.ts";

// Hook filenames (kebab-case) -> HookFlags keys (camelCase)
const HOOK_FILENAME_MAP: Record<string, string> = {
  "on-connect": "onConnect",
  "on-disconnect": "onDisconnect",
  "on-user-transcript": "onUserTranscript",
  "on-error": "onError",
};

export type BundleOutputV2 = {
  manifest: Manifest;
  manifestJson: string;
  toolBundles: Record<string, string>; // toolName -> compiled JS
  hookBundles: Record<string, string>; // hookKey -> compiled JS
  clientDir?: string;
};

/**
 * Compile a single TypeScript file with esbuild.
 * Returns the compiled JS as a string.
 */
async function compileFile(filePath: string): Promise<string> {
  const result = await build({
    entryPoints: [filePath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
  });

  if (result.outputFiles.length === 0) {
    throw new Error(`esbuild produced no output for ${filePath}`);
  }

  return result.outputFiles[0].text;
}

/**
 * Bundle an agent directory into a manifest + compiled handler code.
 *
 * 1. Scans the directory to produce a validated Manifest
 * 2. Compiles each tool handler with esbuild
 * 3. Compiles each hook handler with esbuild
 * 4. Returns manifest + compiled JS strings
 */
export async function bundleAgentV2(agentDir: string): Promise<BundleOutputV2> {
  const manifest = await scanAgentDirectory(agentDir);

  const toolBundles: Record<string, string> = {};
  const hookBundles: Record<string, string> = {};

  // Compile tool handlers
  const toolsDir = path.join(agentDir, "tools");
  for (const toolName of Object.keys(manifest.tools)) {
    const filePath = path.join(toolsDir, `${toolName}.ts`);
    toolBundles[toolName] = await compileFile(filePath);
  }

  // Compile hook handlers
  const hooksDir = path.join(agentDir, "hooks");
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
