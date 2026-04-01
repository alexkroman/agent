// Copyright 2025 the AAI authors. MIT license.
/**
 * Loads the compiled harness runtime JS for injection into secure-exec isolates.
 *
 * The actual harness logic lives in `harness-runtime.ts` (type-checked at
 * compile time). This module reads the compiled `.js` output so it can be
 * written to the isolate's virtual filesystem.
 *
 * The harness bundle may include code-split chunks (e.g. for lazy-loaded
 * dependencies like secure-exec and html-to-text). All chunks are loaded
 * and written to the isolate's virtual filesystem.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type HarnessFiles = { name: string; content: string }[];

let cached: HarnessFiles | null = null;

/**
 * Get all compiled harness runtime files (main entry + code-split chunks).
 * Cached after first read.
 */
export async function getHarnessFiles(): Promise<HarnessFiles> {
  if (cached) return cached;

  // Determine the dist directory
  const distCandidates = [__dirname, path.join(__dirname, "..", "dist")];

  for (const dir of distCandidates) {
    try {
      const entries = await fs.readdir(dir);
      const mainEntry = entries.find(
        (e) => e === "harness-runtime.mjs" || e === "harness-runtime.js",
      );
      if (!mainEntry) continue;

      // Read the main entry
      const mainContent = await fs.readFile(path.join(dir, mainEntry), "utf-8");

      // Find and read all code-split chunks referenced by the harness
      // (esm-*.mjs, html-to-text-*.mjs, etc.)
      const chunkFiles = entries.filter(
        (e) => e !== mainEntry && e !== "index.mjs" && e !== "index.js" && e.endsWith(".mjs"),
      );

      const files: HarnessFiles = [{ name: mainEntry, content: mainContent }];
      for (const chunk of chunkFiles) {
        const content = await fs.readFile(path.join(dir, chunk), "utf-8");
        files.push({ name: chunk, content });
      }

      cached = files;
      return files;
    } catch {
      // Try next candidate
    }
  }

  throw new Error(
    "Harness runtime JS not found. Run `pnpm --filter @alexkroman1/aai-server build` first.",
  );
}

/**
 * Get just the main harness runtime JS code.
 * @deprecated Use {@link getHarnessFiles} to load all chunks.
 */
export async function getHarnessRuntimeJs(): Promise<string> {
  const files = await getHarnessFiles();
  const main = files.find(
    (f) => f.name === "harness-runtime.mjs" || f.name === "harness-runtime.js",
  );
  if (!main) throw new Error("Main harness entry not found in loaded files");
  return main.content;
}
