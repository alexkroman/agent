#!/usr/bin/env node

/**
 * Syncs the scaffold package.json against the workspace:
 *
 * - Workspace dependency versions (@alexkroman1/*) become ^x.y.z ranges
 *   matching the current workspace package versions.
 * - Shared third-party deps (react, vite, typescript, ...) are copied from
 *   the workspace package that declares them, so the scaffold never drifts
 *   from what the repo actually builds and tests with. (The scaffold is
 *   deliberately excluded from syncpack — see .syncpackrc.json — so this
 *   script is the only guard.)
 * - `packageManager` is copied from the root package.json.
 *
 * Run automatically after `changeset version` in the release workflow.
 * Pass `--check` to report drift and exit 1 without writing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const checkOnly = process.argv.includes("--check");
const root = new URL("..", import.meta.url).pathname;
const scaffoldPath = join(root, "packages/aai-templates/scaffold/package.json");

/** Workspace packages whose *own* version the scaffold must track. */
const pkgMap = {
  "@alexkroman1/aai": "packages/aai/package.json",
  "@alexkroman1/aai-ui": "packages/aai-ui/package.json",
  "@alexkroman1/aai-cli": "packages/aai-cli/package.json",
};

/**
 * Shared third-party deps: dep name → workspace package.json that declares
 * the authoritative range (searched across dependencies, devDependencies,
 * and peerDependencies).
 */
const sharedDepSources = {
  react: "packages/aai-ui/package.json",
  "react-dom": "packages/aai-ui/package.json",
  "@types/react": "packages/aai-ui/package.json",
  "@types/react-dom": "packages/aai-ui/package.json",
  tailwindcss: "packages/aai-ui/package.json",
  "@tailwindcss/vite": "packages/aai-ui/package.json",
  "@vitejs/plugin-react": "packages/aai-ui/package.json",
  vite: "packages/aai-cli/package.json",
  zod: "packages/aai/package.json",
  typescript: "package.json",
  vitest: "package.json",
  "@types/node": "package.json",
};

/** Read and parse a package.json, failing loudly with the offending path. */
function readJson(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`sync-scaffold-versions: failed to read ${path}: ${err.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`sync-scaffold-versions: failed to parse ${path}: ${err.message}`);
    process.exit(1);
  }
}

const scaffold = readJson(scaffoldPath);
let changed = false;

/** Set scaffold's range for `dep` in whichever section already declares it. */
function syncDep(dep, range, source) {
  for (const section of ["dependencies", "devDependencies"]) {
    if (scaffold[section]?.[dep] && scaffold[section][dep] !== range) {
      console.log(`${section}.${dep}: ${scaffold[section][dep]} → ${range} (from ${source})`);
      scaffold[section][dep] = range;
      changed = true;
    }
  }
}

for (const [dep, pkgPath] of Object.entries(pkgMap)) {
  const { version } = readJson(join(root, pkgPath));
  // Never let a missing version become a literal "^undefined" in the scaffold.
  if (typeof version !== "string" || version.length === 0) {
    console.error(
      `sync-scaffold-versions: ${pkgPath} has no valid "version" field (got ${JSON.stringify(version)}).`,
    );
    process.exit(1);
  }
  syncDep(dep, `^${version}`, pkgPath);
}

for (const [dep, pkgPath] of Object.entries(sharedDepSources)) {
  const pkg = readJson(join(root, pkgPath));
  const range =
    pkg.dependencies?.[dep] ?? pkg.devDependencies?.[dep] ?? pkg.peerDependencies?.[dep];
  if (typeof range !== "string" || range.length === 0) {
    console.error(
      `sync-scaffold-versions: ${pkgPath} no longer declares "${dep}" — update sharedDepSources.`,
    );
    process.exit(1);
  }
  syncDep(dep, range, pkgPath);
}

const { packageManager } = readJson(join(root, "package.json"));
if (typeof packageManager === "string" && scaffold.packageManager !== packageManager) {
  console.log(`packageManager: ${scaffold.packageManager} → ${packageManager} (from package.json)`);
  scaffold.packageManager = packageManager;
  changed = true;
}

if (changed) {
  if (checkOnly) {
    console.error("sync-scaffold-versions: scaffold package.json is out of sync (see above).");
    console.error("Run `node scripts/sync-scaffold-versions.mjs` to fix.");
    process.exit(1);
  }
  try {
    writeFileSync(scaffoldPath, `${JSON.stringify(scaffold, null, 2)}\n`);
  } catch (err) {
    console.error(`sync-scaffold-versions: failed to write ${scaffoldPath}: ${err.message}`);
    process.exit(1);
  }
  console.log("Scaffold package.json updated.");
} else {
  console.log("Scaffold package.json already in sync.");
}
