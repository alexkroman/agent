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
 * - A `catalog:` specifier is RESOLVED to the range the catalog holds, never
 *   copied. `catalog:` is a pnpm workspace protocol and the scaffold ships to
 *   users, where npm reads it as an unsatisfiable range — so a catalogued
 *   dependency is precisely the case this script has to translate. Copying it
 *   verbatim is what the catalog migration silently started doing, and the
 *   symptom would not have appeared here: this script runs UNCHECKED from the
 *   `version` script after `changeset version`, so the first sign would have
 *   been `aai init` failing at its own install step for every user.
 * - `packageManager` is copied from the root package.json.
 *
 * Run automatically after `changeset version` in the release workflow.
 * Pass `--check` to report drift and exit 1 without writing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { parseScriptArgs } from "./_args.mjs";
import { readManifest, repoRoot } from "./_fs.mjs";

const { values: flags } = parseScriptArgs({
  script: import.meta.url,
  options: { check: { type: "boolean" } },
});
const checkOnly = flags.check === true;
const root = repoRoot(import.meta.url);
const scaffoldPath = join(root, "packages/aai-templates/scaffold/package.json");
const workspacePath = join(root, "pnpm-workspace.yaml");

/** Workspace packages whose *own* version the scaffold must track. */
const pkgMap = {
  "@alexkroman1/aai": "packages/aai/package.json",
  "@alexkroman1/aai-ui": "packages/aai-ui/package.json",
  "@alexkroman1/aai-cli": "packages/aai-cli/package.json",
  "@alexkroman1/aai-runtime": "packages/aai-runtime/package.json",
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
  // Same shape as the two above, for the same reason: a template's `agent.ts`
  // imports `setup` from `xstate` DIRECTLY (a machine is authored, not wrapped),
  // and xstate reaches a project only through `@alexkroman1/aai` — which npm
  // hoists and pnpm does not. Without the declaration a scaffolded project that
  // uses `flow()` fails to resolve it under pnpm and resolves it by accident
  // under npm, which is the worse of the two.
  xstate: "packages/aai/package.json",
  typescript: "package.json",
  vitest: "package.json",
  "@types/node": "package.json",
};

// `readJson` is `_fs.mjs`'s. The fail-loudly-with-the-path behaviour that was
// written here is the one the shared version kept, because a parse error inside
// a gate otherwise arrives as `Unexpected token }` with no file attached.

/** The workspace catalogs, read once: `catalog` is the default, `catalogs` the named ones. */
const workspace = (() => {
  let text;
  try {
    text = readFileSync(workspacePath, "utf8");
  } catch (err) {
    console.error(`sync-scaffold-versions: failed to read ${workspacePath}: ${err.message}`);
    process.exit(1);
  }
  try {
    return parseYaml(text) ?? {};
  } catch (err) {
    console.error(`sync-scaffold-versions: failed to parse ${workspacePath}: ${err.message}`);
    process.exit(1);
  }
})();

/**
 * Resolve a specifier to a literal range, translating `catalog:` (the default
 * catalog) and `catalog:<name>` (a named one) into the range that catalog
 * holds. Anything else is already literal and passes through.
 *
 * Failures exit rather than fall back: the caller is about to write this value
 * into a manifest that ships, so an unresolved `catalog:` is worse than no
 * write at all.
 */
function resolveSpecifier(spec, dep, source) {
  if (!spec.startsWith("catalog:")) return spec;

  const name = spec.slice("catalog:".length).trim() || "default";
  const catalog = name === "default" ? workspace.catalog : workspace.catalogs?.[name];
  if (!catalog) {
    console.error(
      `sync-scaffold-versions: ${source} declares "${dep}": "${spec}", but ` +
        `pnpm-workspace.yaml has no ${name === "default" ? "`catalog:`" : `\`catalogs.${name}\``} block.`,
    );
    process.exit(1);
  }

  const range = catalog[dep];
  if (typeof range !== "string" || range.length === 0) {
    console.error(
      `sync-scaffold-versions: ${source} declares "${dep}": "${spec}", but the ` +
        `${name} catalog has no entry for "${dep}".`,
    );
    process.exit(1);
  }
  // Catalogs do not nest, so a `catalog:` here means the entry is malformed
  // rather than that another lookup is owed.
  if (range.startsWith("catalog:")) {
    console.error(
      `sync-scaffold-versions: the ${name} catalog maps "${dep}" to "${range}", ` +
        "which is not a version range.",
    );
    process.exit(1);
  }
  return range;
}

const scaffold = readManifest(scaffoldPath);
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
  const { version } = readManifest(join(root, pkgPath));
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
  const pkg = readManifest(join(root, pkgPath));
  const range =
    pkg.dependencies?.[dep] ?? pkg.devDependencies?.[dep] ?? pkg.peerDependencies?.[dep];
  if (typeof range !== "string" || range.length === 0) {
    console.error(
      `sync-scaffold-versions: ${pkgPath} no longer declares "${dep}" — update sharedDepSources.`,
    );
    process.exit(1);
  }
  syncDep(dep, resolveSpecifier(range, dep, pkgPath), pkgPath);
}

// Independently of the map above: NO specifier in the shipped manifest may be a
// pnpm workspace protocol. `sharedDepSources` is hand-kept, so it only sees the
// deps somebody remembered to list — a dep outside it that gets hand-edited to
// `catalog:` is synced by nothing and caught by nothing else either. The three
// publishable packages are covered by check:publish-protocols, which packs them
// and reads the manifest pnpm rewrote; this file is DATA inside the aai-cli
// tarball rather than a manifest pnpm packs, so no rewrite ever touches it.
const workspaceProtocols = ["catalog:", "workspace:"];
const leaked = [];
for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
  for (const [dep, spec] of Object.entries(scaffold[section] ?? {})) {
    if (typeof spec === "string" && workspaceProtocols.some((p) => spec.startsWith(p))) {
      leaked.push(`${section}.${dep}: ${spec}`);
    }
  }
}
if (leaked.length > 0) {
  console.error(
    "sync-scaffold-versions: the scaffold manifest ships to users, where a pnpm\n" +
      "workspace protocol is an unsatisfiable range. Replace each with a literal range:",
  );
  for (const entry of leaked) console.error(`  ${entry}`);
  process.exit(1);
}

const { packageManager } = readManifest(join(root, "package.json"));
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
