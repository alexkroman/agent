#!/usr/bin/env node

// Dev-mode entry point: builds the CLI, then runs dist/aai.js.
// Same code path as production — just rebuilds first.
// Usage: pnpm link:global → `aai` command always runs fresh build.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Build CLI (fast — tsup is incremental)
execFileSync("npx", ["tsup", "--silent"], { cwd: cliRoot, stdio: "inherit" });

// Run the same dist/aai.js that production uses
try {
  execFileSync(process.execPath, [resolve(cliRoot, "dist/aai.js"), ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
