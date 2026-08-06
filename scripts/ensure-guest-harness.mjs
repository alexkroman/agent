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
 *
 * **It builds only when NOT already inside a turbo task** (`TURBO_HASH`),
 * where the build is turbo's job and rebuilding races the run's other tasks —
 * see the comment on that branch below. So the mtime staleness check serves
 * the direct callers (`predev`, `predeploy:modal`, a bare `vitest`), and turbo
 * runs get a verification instead.
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
  // Inside a turbo task, VERIFY — never build. Turbo already orders
  // `aai-guest#build` ahead of every consumer (`^build` on aai-server's test
  // task, `build` on check:integration), and it decides staleness by hashing
  // inputs, which is correct where the mtime heuristic below is merely a
  // guess. The guess is WRONG in the ordinary case: a cache HIT restores
  // `dist/harness.mjs` with the archived mtime, so an unrelated edit anywhere
  // in `packages/aai` makes a byte-correct harness look stale, and this
  // globalSetup then spawns a NESTED `turbo run build` inside the parent
  // turbo run. Two tsdown processes then write `dist/` while sibling tasks
  // read it: `aai-studio-server#test` (no globalSetup of its own) and
  // `aai-server#check:integration` both fail with "Guest harness not built"
  // or MODULE_NOT_FOUND on `aai-guest`, naming a file nothing in their own
  // package touched. It is the mirror image of the race documented in
  // `packages/aai-server/turbo.json` — that comment notes this script cannot
  // wait out a harness being rebuilt underneath it; this is the same script
  // BEING that rebuild.
  //
  // A missing harness under turbo is therefore a dependency-graph bug, not
  // something to paper over by building: the task that needs it failed to
  // declare it, and every other task in the run is one unlucky interleaving
  // from the same failure. Say so instead.
  if (process.env.TURBO_HASH) {
    if (builtAt === 0) {
      throw new Error(
        "Guest harness not built, and this task runs under turbo — a rebuild " +
          "here would race sibling tasks reading dist/. Declare the build " +
          "instead: add `^build` (or `aai-guest#build`) to this task's " +
          "dependsOn in turbo.json.",
      );
    }
    return;
  }
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
