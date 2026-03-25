// Copyright 2025 the AAI authors. MIT license.
/**
 * Loads the compiled harness runtime JS for injection into secure-exec isolates.
 *
 * The actual harness logic lives in `_harness-runtime.ts` (type-checked at
 * compile time). This module reads the compiled `.js` output so it can be
 * written to the isolate's virtual filesystem.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedHarnessJs: string | null = null;

/**
 * Get the compiled harness runtime JS code.
 *
 * Reads from the compiled `dist/` output (sibling `_harness-runtime.mjs`).
 * Cached after first read.
 */
export async function getHarnessRuntimeJs(): Promise<string> {
  if (cachedHarnessJs) return cachedHarnessJs;

  // In production (running from dist/), read sibling file
  // In dev mode (running from src/), read from dist/
  const candidates = [
    path.join(__dirname, "_harness-runtime.mjs"),
    path.join(__dirname, "_harness-runtime.js"),
    path.join(__dirname, "..", "dist", "_harness-runtime.mjs"),
    path.join(__dirname, "..", "dist", "_harness-runtime.js"),
  ];

  for (const candidate of candidates) {
    try {
      cachedHarnessJs = await fs.readFile(candidate, "utf-8");
      return cachedHarnessJs;
    } catch {
      // Try next candidate path
    }
  }

  throw new Error(
    "Harness runtime JS not found. Run `pnpm --filter @alexkroman1/aai-server build` first.",
  );
}
