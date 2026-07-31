// Copyright 2026 the AAI authors. MIT license.
/**
 * Build the aai-guest harness bundle when it is missing or stale, so test
 * runs that spawn sandboxes (aai-server unit tests mock the Modal dial but
 * still resolve `aai-guest/harness` eagerly in createSandbox) never die on
 * "Guest harness not built".
 *
 * Callers:
 *   - vitest globalSetup (default export) — wired into the aai-server test
 *     project, runs once per vitest invocation.
 *   - `predev` in aai-server and aai-studio-server — dev servers spawn
 *     subprocess-backend sandboxes from `dist/harness.mjs`, so a dev boot
 *     always starts with a fresh harness.
 *   - `predeploy:modal` in both server packages — the Modal image rebuilds
 *     the harness remotely, so this is a fail-fast: catch a guest package
 *     that doesn't build before paying for the remote image build.
 *   - CLI: `node scripts/ensure-guest-harness.mjs`
 *
 * Staleness tracks the sources of aai-guest AND the aai SDK it bundles.
 * Rebuilds go through turbo so `@alexkroman1/aai` builds first: the guest
 * bundler resolves the SDK via its dist exports, and without a built dist
 * the SDK imports are silently left external — a harness that "builds"
 * but crashes on import inside the sandbox, which has no node_modules.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const guestDir = join(repoRoot, "packages", "aai-guest");
const sdkDir = join(repoRoot, "packages", "aai");
const harnessPath = join(guestDir, "dist", "harness.mjs");

function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `.turbo/` logs and `*.tsbuildinfo` are build BYPRODUCTS written after
    // the harness — counting them as sources makes every run a "rebuild".
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
      continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(path));
    } else if (!entry.name.endsWith(".test.ts") && !entry.name.endsWith(".tsbuildinfo")) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

export function ensureGuestHarness() {
  // The caller points at a harness of their own — trust it.
  if (process.env.GUEST_HARNESS_PATH) return;
  const builtAt = existsSync(harnessPath) ? statSync(harnessPath).mtimeMs : 0;
  if (builtAt > Math.max(newestSourceMtime(guestDir), newestSourceMtime(sdkDir))) return;
  console.info(
    builtAt === 0
      ? "Guest harness not built — building aai-guest..."
      : "Guest harness older than aai-guest/aai sources — rebuilding...",
  );
  // Through turbo so the aai SDK's dist builds first (see module doc).
  execFileSync("pnpm", ["exec", "turbo", "run", "build", "--filter", "aai-guest"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

// vitest globalSetup entry.
export default function globalSetup() {
  ensureGuestHarness();
}

// CLI entry.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureGuestHarness();
}
