#!/usr/bin/env node

// Dev-mode entry point: runs cli.ts via tsx (no build required).
// Usage: pnpm link:global → `aai` command runs live source everywhere.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  execFileSync(
    resolve(cliRoot, "node_modules/.bin/tsx"),
    [resolve(cliRoot, "cli.ts"), ...process.argv.slice(2)],
    { stdio: "inherit", cwd: process.cwd() },
  );
} catch (e) {
  process.exit(e.status ?? 1);
}
