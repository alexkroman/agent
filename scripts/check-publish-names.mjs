#!/usr/bin/env node

/**
 * Regression guard for #456 (Release workflow #350).
 *
 * Publishable packages must use the `@alexkroman1/` scope. The unscoped
 * names `aai`, `aai-ui`, `aai-cli` are owned by other publishers on npm,
 * so a publish returns `404 Not Found - PUT https://registry.npmjs.org/aai`.
 *
 * This script walks every `packages/*\/package.json` that isn't marked
 * `"private": true` and fails when the `name` field isn't under an allowed
 * scope. Wired up as `pnpm check:publish-names` in CI.
 *
 * It also checks `repository`, which is a SECOND way the same publish dies —
 * and one that only the release job can see. `ship.yml` sets
 * `NPM_CONFIG_PROVENANCE: true`, so npm signs the source repo via OIDC and
 * then requires the manifest to agree with it; an absent `repository` reads as
 * the empty string and the publish fails
 *
 *     E422: Error verifying sigstore provenance bundle: Failed to validate
 *     repository information: package.json: "repository.url" is "", expected
 *     to match "https://github.com/alexkroman/agent" from provenance
 *
 * `@alexkroman1/aai-runtime` shipped with the field missing because nothing
 * looked at it: `publint` and `attw` ask packaging questions, konsistent's
 * `publishable-package-layout` checks which FILES a package has, and a
 * hand-publish (which is how that package's first version reached npm) does
 * not set `NPM_CONFIG_PROVENANCE`. So the one path that evaluates this field
 * is a push to main, after the version is already burned and two sibling
 * packages are already published — the fixed release group splits by a major
 * while it is fixed. That is the most expensive place in the repo to find a
 * one-line manifest omission.
 *
 * The expected url is CONSENSUS among the publishable packages rather than a
 * constant here, so the repo can be renamed or moved without editing this
 * gate — the real failure mode is one package diverging from its siblings,
 * which is what a new package added to the release group does.
 */

import { join } from "node:path";

import { publishablePackages, readJson, repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url);
const ALLOWED_SCOPES = ["@alexkroman1/"];

/** `https://github.com/<owner>/<repo>.git` — the form npm's provenance check reads. */
const REPO_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/;

const errors = [];

/** @type {{ dir: string, path: string, pkg: Record<string, unknown> }[]} */
const manifests = [];

for (const dir of publishablePackages(ROOT)) {
  const pkgJsonPath = join(ROOT, dir, "package.json");
  try {
    manifests.push({ dir, path: pkgJsonPath, pkg: readJson(pkgJsonPath) });
  } catch (err) {
    errors.push(`${pkgJsonPath}: ${err.message}`);
  }
}

for (const { path, pkg } of manifests) {
  if (typeof pkg.name !== "string") {
    errors.push(`${path}: missing "name" field`);
    continue;
  }

  const ok = ALLOWED_SCOPES.some((scope) => pkg.name.startsWith(scope));
  if (!ok) {
    errors.push(
      `${path}: name "${pkg.name}" is not under an allowed scope ` +
        `(${ALLOWED_SCOPES.join(", ")}). ` +
        `Unscoped names like "aai" are already taken on npm and publish ` +
        "will 404. Either rename under @alexkroman1/ or mark the package " +
        "private.",
    );
  }
}

// The url every publishable package must agree on. Consensus, not a constant —
// see the header. A tie cannot happen with fewer than two dissenters, and with
// two the gate reports both against the majority, which is the honest report.
const urls = manifests
  .map(({ pkg }) => pkg.repository?.url)
  .filter((url) => typeof url === "string" && url !== "");
const tally = new Map();
for (const u of urls) tally.set(u, (tally.get(u) ?? 0) + 1);
let expectedUrl;
for (const [u, n] of tally) {
  if (expectedUrl === undefined || n > (tally.get(expectedUrl) ?? 0)) expectedUrl = u;
}

for (const { dir, path, pkg } of manifests) {
  // Optional chaining rather than a record guard: a non-object `repository`
  // yields `undefined` here and lands in the same branch as an absent one,
  // which is the same remedy.
  const repo = pkg.repository;
  if (typeof repo?.url !== "string" || repo.url === "") {
    errors.push(
      `${path}: missing "repository.url". ship.yml publishes with ` +
        "NPM_CONFIG_PROVENANCE=true, which requires the manifest to name the " +
        "repo it was built from; without it the publish fails E422 " +
        '(`"repository.url" is ""`) AFTER sibling packages in the fixed ' +
        "release group have already published" +
        (expectedUrl === undefined ? "." : `. Expected: ${expectedUrl}`),
    );
    continue;
  }
  if (!REPO_URL.test(repo.url)) {
    errors.push(
      `${path}: repository.url "${repo.url}" is not of the form ` +
        "https://github.com/<owner>/<repo>.git, which is what npm's " +
        "provenance check compares against.",
    );
  } else if (expectedUrl !== undefined && repo.url !== expectedUrl) {
    errors.push(
      `${path}: repository.url "${repo.url}" disagrees with the other ` +
        `publishable packages ("${expectedUrl}"). Provenance is signed for ` +
        "one repo, so only one of these can publish.",
    );
  }
  if (repo.directory !== dir) {
    errors.push(
      `${path}: repository.directory is ${JSON.stringify(repo.directory)}, ` +
        `expected "${dir}" — npm links "source" from this field.`,
    );
  }
}

// A floor, for the reason every gate here now has one: this script's entire
// success output is a sentence, so a scan that stopped finding packages would
// print it over nothing.
if (publishablePackages(ROOT).length === 0) {
  console.error("check-publish-names: found no publishable packages — is the scan still right?");
  process.exit(1);
}

if (errors.length > 0) {
  console.error("check-publish-names: publishable packages have invalid publish metadata:\n");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `check-publish-names: all ${manifests.length} publishable packages use an allowed ` +
    "scope and name their repository.",
);
