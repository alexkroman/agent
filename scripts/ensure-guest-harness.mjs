// Copyright 2026 the AAI authors. MIT license.
/**
 * Build the aai-guest harness bundle when it is missing or stale, so test
 * runs that spawn sandboxes (aai-server unit tests mock the Modal dial but
 * still resolve `aai-guest/harness` eagerly in createSandbox) never die on
 * "Guest harness not built".
 *
 * Dual-use:
 *   - vitest globalSetup (default export) — wired into the aai-server test
 *     project, runs once per vitest invocation.
 *   - CLI: `node scripts/ensure-guest-harness.mjs`
 *
 * Staleness tracks the aai-guest package's own sources only. The harness
 * also bundles the aai SDK, so an SDK-only edit does NOT trigger a rebuild
 * here — `pnpm --filter aai-guest build` (or the turbo build graph) stays
 * the authority when working on the SDK↔harness seam.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const guestDir = join(repoRoot, "packages", "aai-guest");
const harnessPath = join(guestDir, "dist", "harness.mjs");

function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(path));
    } else if (!entry.name.endsWith(".test.ts")) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

export function ensureGuestHarness() {
  // The caller points at a harness of their own — trust it.
  if (process.env.GUEST_HARNESS_PATH) return;
  const builtAt = existsSync(harnessPath) ? statSync(harnessPath).mtimeMs : 0;
  if (builtAt > newestSourceMtime(guestDir)) return;
  console.info(
    builtAt === 0
      ? "Guest harness not built — building aai-guest..."
      : "Guest harness older than aai-guest sources — rebuilding...",
  );
  execFileSync("pnpm", ["--filter", "aai-guest", "build"], { cwd: repoRoot, stdio: "inherit" });
}

// vitest globalSetup entry.
export default function globalSetup() {
  ensureGuestHarness();
}

// CLI entry.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureGuestHarness();
}
