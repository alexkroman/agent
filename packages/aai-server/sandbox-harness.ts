// Copyright 2025 the AAI authors. MIT license.
/**
 * Loads the harness runtime JS for injection into secure-exec isolates.
 *
 * The actual harness logic lives in `harness-runtime.ts` (type-checked at
 * compile time). This module either reads the compiled `.mjs` output from dist
 * or auto-compiles from source when the source is newer (dev/test mode).
 *
 * Auto-compilation uses esbuild to bundle `harness-runtime.ts` with the same
 * deps as the tsdown build config. This prevents stale compiled artifacts
 * from silently breaking tests after source changes.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type HarnessFiles = { name: string; content: string }[];

let cached: HarnessFiles | null = null;

/** Check if source is newer than compiled output. */
async function sourceIsNewer(sourceDir: string, distDir: string): Promise<boolean> {
  try {
    const sourcePath = path.join(sourceDir, "harness-runtime.ts");
    const distPath = path.join(distDir, "harness-runtime.mjs");
    const [srcStat, distStat] = await Promise.all([
      fs.stat(sourcePath).catch(() => null),
      fs.stat(distPath).catch(() => null),
    ]);
    if (!srcStat) return false; // no source, use dist
    if (!distStat) return true; // no dist, must compile
    return srcStat.mtimeMs > distStat.mtimeMs;
  } catch {
    return false;
  }
}

/** Bundle harness-runtime.ts from source using esbuild. */
async function compileFromSource(sourceDir: string): Promise<HarnessFiles> {
  const esbuild = await import("esbuild");
  const entryPoint = path.join(sourceDir, "harness-runtime.ts");

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    // Bundle workspace packages that the harness imports at runtime
    // (same as tsdown config: hookable, aai/hooks, aai/utils)
    external: ["@alexkroman1/aai/kv", "@alexkroman1/aai/types"],
    // Resolve workspace packages
    conditions: ["import", "default"],
  });

  // biome-ignore lint/style/noNonNullAssertion: esbuild always produces at least one output file
  const content = new TextDecoder().decode(result.outputFiles[0]!.contents);
  return [{ name: "harness-runtime.mjs", content }];
}

/** Load pre-compiled harness files from the dist directory. */
async function loadFromDist(distDir: string): Promise<HarnessFiles | null> {
  try {
    const entries = await fs.readdir(distDir);
    const mainEntry = entries.find(
      (e) => e === "harness-runtime.mjs" || e === "harness-runtime.js",
    );
    if (!mainEntry) return null;

    const mainContent = await fs.readFile(path.join(distDir, mainEntry), "utf-8");

    // Find and read code-split chunks (esm-*.mjs, etc.)
    const chunkFiles = entries.filter(
      (e) => e !== mainEntry && e !== "index.mjs" && e !== "index.js" && e.endsWith(".mjs"),
    );

    const files: HarnessFiles = [{ name: mainEntry, content: mainContent }];
    for (const chunk of chunkFiles) {
      const content = await fs.readFile(path.join(distDir, chunk), "utf-8");
      files.push({ name: chunk, content });
    }

    return files;
  } catch {
    return null;
  }
}

/**
 * Get harness runtime files for injection into isolates.
 *
 * In dev/test mode (source newer than dist), auto-compiles from TypeScript.
 * In production (pre-built dist), reads compiled JS from dist.
 * Cached after first read.
 */
export async function getHarnessFiles(): Promise<HarnessFiles> {
  if (cached) return cached;

  const distDir = path.join(__dirname, "dist");
  const sourceDir = __dirname;

  // Auto-compile if source is newer than dist
  if (await sourceIsNewer(sourceDir, distDir)) {
    cached = await compileFromSource(sourceDir);
    return cached;
  }

  // Try loading from dist
  const fromDist = await loadFromDist(distDir);
  if (fromDist) {
    cached = fromDist;
    return cached;
  }

  // Fallback: try __dirname directly (for when dist files are alongside source)
  const fromSource = await loadFromDist(sourceDir);
  if (fromSource) {
    cached = fromSource;
    return cached;
  }

  // Last resort: compile from source
  cached = await compileFromSource(sourceDir);
  return cached;
}
