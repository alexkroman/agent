// Copyright 2025 the AAI authors. MIT license.
/**
 * Loads the compiled harness runtime JS for injection into secure-exec isolates.
 *
 * The actual harness logic lives in `_harness_runtime.ts` (type-checked at
 * compile time). This module reads the compiled `.js` output so it can be
 * written to the isolate's virtual filesystem.
 *
 * @module
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedHarnessJs: string | null = null;

/**
 * Get the compiled harness runtime JS code.
 *
 * Reads from the compiled `dist/` output (sibling `_harness_runtime.js`).
 * Cached after first read.
 */
export async function getHarnessRuntimeJs(): Promise<string> {
  if (cachedHarnessJs) return cachedHarnessJs;

  // In dev mode (running from src/), read from dist/
  // In production (running from dist/), read sibling file
  const candidates = [
    path.join(__dirname, "_harness_runtime.cjs"),
    path.join(__dirname, "_harness_runtime.js"),
    path.join(__dirname, "..", "dist", "_harness_runtime.cjs"),
    path.join(__dirname, "..", "dist", "_harness_runtime.js"),
  ];

  for (const candidate of candidates) {
    try {
      cachedHarnessJs = await fs.readFile(candidate, "utf-8");
      return cachedHarnessJs;
    } catch {}
  }

  throw new Error(
    "Harness runtime JS not found. Run `pnpm --filter @alexkroman1/aai-server build` first.",
  );
}
