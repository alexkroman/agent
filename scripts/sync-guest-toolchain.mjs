#!/usr/bin/env node

/**
 * Syncs the guest toolchain lockfile — `packages/aai-guest/toolchain/`.
 *
 * ## What is locked, and what cannot be
 *
 * The guest image installs a build toolchain into `/opt/aai/node_modules`
 * (see aai-server/modal-harness-image.ts). Without a lockfile, the resolved
 * tree is a function of WHEN the image layer was built — while both the
 * published image tag and Modal's layer cache key on the install command's
 * text. One `harness_image_tag` could then mean two different trees, which is
 * the opposite of the per-deploy environment pinning that tag exists for.
 *
 * The toolchain therefore splits in two:
 *
 * - **Third-party packages are LOCKED.** Their versions and integrity hashes
 *   are known at commit time, so `toolchain/package.json` +
 *   `toolchain/package-lock.json` are committed and the image runs `npm ci`.
 *   This is where nearly all the transitive surface lives (vite/rolldown,
 *   typescript, vitest, react, tailwind), so it is where locking pays.
 * - **The `@alexkroman1/*` packages CANNOT be locked here.** Their versions
 *   change with every release, and a lockfile entry needs an integrity hash
 *   that only exists once the version is PUBLISHED — which happens after the
 *   commit that bumps it. Locking them would make the release order
 *   impossible. They are installed separately at exact resolved versions, so
 *   their own dependencies (the provider SDKs) still resolve at install time.
 *   That residual gap is deliberate and documented; closing it needs a
 *   post-publish regeneration step, not a lockfile in this repo.
 *
 * ## Usage
 *
 *   node scripts/sync-guest-toolchain.mjs           # regenerate (needs npm registry)
 *   node scripts/sync-guest-toolchain.mjs --check    # report drift, exit 1, no network
 *
 * `--check` is a pure JSON comparison so it can run in `pnpm check` and CI
 * without a registry: it verifies the committed manifest matches the versions
 * this checkout installed, and that the lockfile's root dependency map
 * matches the manifest. Regenerating needs the registry (for integrity
 * hashes) and so is a deliberate local/release step.
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseScriptArgs } from "./_args.mjs";
import { readJson, readManifest, repoRoot } from "./_fs.mjs";

const { values: flags } = parseScriptArgs({
  script: import.meta.url,
  options: { check: { type: "boolean" } },
});
const checkOnly = flags.check === true;
const root = repoRoot(import.meta.url);
const guestPkgPath = join(root, "packages/aai-guest/package.json");
const toolchainDir = join(root, "packages/aai-guest/toolchain");
const manifestPath = join(toolchainDir, "package.json");
const lockPath = join(toolchainDir, "package-lock.json");

/**
 * The third-party packages the guest image locks. Must stay a subset of
 * aai-guest's own dependencies — that is what keeps the baked toolchain and
 * the toolchain the repo builds and tests with from drifting.
 *
 * The `@alexkroman1/*` packages are deliberately absent (see the module doc);
 * aai-server/modal-harness-image.ts installs those separately.
 */
const LOCKED_PACKAGES = [
  "@tailwindcss/vite",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "react",
  "react-dom",
  "tailwindcss",
  "typescript",
  "vite",
  "vitest",
  "xstate",
  "zod",
];

// `readJson` is `_fs.mjs`'s — it names the offending path on a read or parse
// failure, which this copy did not.

/** The version each locked package resolves to in THIS checkout. */
function installedVersions() {
  const guestPkg = readManifest(guestPkgPath);
  const declared = { ...guestPkg.dependencies, ...guestPkg.devDependencies };
  const versions = {};
  for (const name of LOCKED_PACKAGES) {
    if (!declared[name]) {
      throw new Error(
        `aai-guest/package.json no longer declares ${name} — remove it from LOCKED_PACKAGES or restore the dependency`,
      );
    }
    const installed = join(root, "packages/aai-guest/node_modules", name, "package.json");
    if (!existsSync(installed)) {
      throw new Error(`${name} is declared but not installed at ${installed} — run pnpm install`);
    }
    versions[name] = readManifest(installed).version;
  }
  return versions;
}

function expectedManifest(versions) {
  return `${JSON.stringify(
    {
      name: "aai-guest-toolchain",
      private: true,
      // The image installs into a prefix and never runs this package's
      // scripts; the manifest exists to be the input `npm ci` validates the
      // lockfile against.
      dependencies: versions,
    },
    null,
    2,
  )}\n`;
}

const versions = installedVersions();

/**
 * The two shapes `pick` reaches into: the toolchain manifest's own
 * `dependencies`, and the lockfile's root importer under `packages[""]`.
 * Declared rather than left as `unknown` so a `pick` that misspells either path
 * is a compile error instead of a silently-empty map — which this gate would
 * report as "everything is in sync".
 *
 * @typedef {object} ToolchainJson
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, { dependencies?: Record<string, string> }>} [packages]
 */

/**
 * Both committed files declare the same dependency map, so both are checked
 * the same way: every installed version present, and nothing extra. Reads the
 * map through `pick` rather than duplicating the loop per file — the two
 * copies of it drifted into different wording for the same problem.
 *
 * Compares PARSED JSON, not bytes: a formatter reaching these files must not
 * be able to fail the gate.
 *
 * @param {string} label
 * @param {string} path
 * @param {(json: ToolchainJson) => Record<string, string> | undefined} pick
 * @returns {string[]}
 */
function drift(label, path, pick) {
  if (!existsSync(path)) return [`${path} is missing`];
  const declared = pick(/** @type {ToolchainJson} */ (readJson(path))) ?? {};
  const problems = [];
  for (const [name, version] of Object.entries(versions)) {
    if (declared[name] !== version) {
      problems.push(
        `${label} has ${name}@${declared[name] ?? "(absent)"}, installed is ${version}`,
      );
    }
  }
  for (const name of Object.keys(declared)) {
    if (!(name in versions)) problems.push(`${label} has stray dependency ${name}`);
  }
  return problems;
}

if (checkOnly) {
  const problems = [
    ...drift("manifest", manifestPath, (json) => json.dependencies),
    ...drift("lockfile", lockPath, (json) => json.packages?.[""]?.dependencies),
  ];
  if (problems.length > 0) {
    console.error("Guest toolchain lockfile is out of date:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nRun: node scripts/sync-guest-toolchain.mjs");
    process.exit(1);
  }
  console.log("Guest toolchain lockfile is up to date.");
  process.exit(0);
}

writeFileSync(manifestPath, expectedManifest(versions));
// `--package-lock-only` resolves and writes the lockfile without installing
// anything, which is all the image build needs from it.
execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], {
  cwd: toolchainDir,
  stdio: "inherit",
});
console.log(`Wrote ${manifestPath} and ${lockPath}`);
