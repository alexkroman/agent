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
 */

import { join } from "node:path";

import { publishablePackages, readJson, repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url);
const ALLOWED_SCOPES = ["@alexkroman1/"];

const errors = [];

for (const dir of publishablePackages(ROOT)) {
  const pkgJsonPath = join(ROOT, dir, "package.json");
  let pkg;
  try {
    pkg = readJson(pkgJsonPath);
  } catch (err) {
    errors.push(`${pkgJsonPath}: ${err.message}`);
    continue;
  }
  if (typeof pkg.name !== "string") {
    errors.push(`${pkgJsonPath}: missing "name" field`);
    continue;
  }

  const ok = ALLOWED_SCOPES.some((scope) => pkg.name.startsWith(scope));
  if (!ok) {
    errors.push(
      `${pkgJsonPath}: name "${pkg.name}" is not under an allowed scope ` +
        `(${ALLOWED_SCOPES.join(", ")}). ` +
        `Unscoped names like "aai" are already taken on npm and publish ` +
        "will 404. Either rename under @alexkroman1/ or mark the package " +
        "private.",
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
  console.error("check-publish-names: publishable packages have invalid names:\n");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log("check-publish-names: all publishable packages use an allowed scope.");
