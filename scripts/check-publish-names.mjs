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
 *
 * ## `license`, and the LICENSE file beside it
 *
 * Same shape as `repository`, found the same way. All four publishable
 * packages shipped with NO `license` field and no `LICENSE` in their own
 * directory: the repo is MIT and says so at the root, but the root file is
 * outside every package, and npm only ever packs the LICENSE it finds in the
 * package dir. So four tarballs went out declaring no terms at all, which
 * registries and every downstream license scanner read as "all rights
 * reserved" — the most restrictive possible reading, on a package published to
 * be depended on.
 *
 * Neither half was visible to anything: `publint` and `attw` ask packaging
 * questions, konsistent's `publishable-package-layout` checks which files a
 * package has (and its predicates cannot read a JSON field at all), and
 * `npm publish` only WARNS. So both are checked here, the field by consensus
 * and the file by existence.
 *
 * ## Why `sideEffects: false` is a claim, not a default
 *
 * `sideEffects` is the one manifest field in this set whose wrong value breaks
 * a CONSUMER's build rather than our publish, and silently. `aai-ui` exports
 * `./styles.css` and all fifteen templates say
 * `import "@alexkroman1/aai-ui/styles.css";` — an import for effect, which a
 * bundler told the package has no side effects may drop, unstyling every
 * scaffolded app with no error anywhere. A package that exports CSS therefore
 * may not claim `false`; it names the css instead.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { publishablePackages, readManifest, repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url);
const ALLOWED_SCOPES = ["@alexkroman1/"];

/** `https://github.com/<owner>/<repo>.git` — the form npm's provenance check reads. */
const REPO_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/;

const errors = [];

/** @type {{ dir: string, path: string, pkg: import("./_fs.mjs").PackageManifest }[]} */
const manifests = [];

/**
 * The `repository` block, or `undefined` when the field is absent or is npm's
 * STRING shorthand.
 *
 * Both readers below want the same thing and both spelled it `pkg.repository?.url`,
 * which reads as a guard and is not one: optional chaining only answers for
 * `null`/`undefined`, so on the string form it is a property read that yields
 * `undefined` by accident rather than by decision. Same landing branch, so this
 * is the behaviour those two sites already had — said once, and checkably.
 *
 * @param {import("./_fs.mjs").PackageManifest} pkg
 * @returns {{ url?: string, directory?: string } | undefined}
 */
function repositoryBlock(pkg) {
  return typeof pkg.repository === "object" ? pkg.repository : undefined;
}

for (const dir of publishablePackages(ROOT)) {
  const pkgJsonPath = join(ROOT, dir, "package.json");
  try {
    manifests.push({ dir, path: pkgJsonPath, pkg: readManifest(pkgJsonPath) });
  } catch (err) {
    errors.push(`${pkgJsonPath}: ${err.message}`);
  }
}

for (const { path, pkg } of manifests) {
  // Bound to a local rather than read through `pkg` each time: the guard below
  // does not survive into the `some` callback, because a closure could observe
  // a `pkg.name` that changed after the check.
  const name = pkg.name;
  if (typeof name !== "string") {
    errors.push(`${path}: missing "name" field`);
    continue;
  }

  const ok = ALLOWED_SCOPES.some((scope) => name.startsWith(scope));
  if (!ok) {
    errors.push(
      `${path}: name "${name}" is not under an allowed scope ` +
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
  .map(({ pkg }) => repositoryBlock(pkg)?.url)
  .filter((url) => typeof url === "string" && url !== "");
const tally = new Map();
for (const u of urls) tally.set(u, (tally.get(u) ?? 0) + 1);
let expectedUrl;
for (const [u, n] of tally) {
  if (expectedUrl === undefined || n > (tally.get(expectedUrl) ?? 0)) expectedUrl = u;
}

for (const { dir, path, pkg } of manifests) {
  // A non-object `repository` lands in the same branch as an absent one, which
  // is the same remedy. See `repositoryBlock`.
  const repo = repositoryBlock(pkg);
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

// The license every publishable package must agree on — consensus, for the
// same reason the url is: a new package joining the release group is what
// diverges, and it should be told which value its siblings use.
const licenses = manifests
  .map(({ pkg }) => pkg.license)
  .filter((license) => typeof license === "string" && license !== "");
const licenseTally = new Map();
for (const l of licenses) licenseTally.set(l, (licenseTally.get(l) ?? 0) + 1);
let expectedLicense;
for (const [l, n] of licenseTally) {
  if (expectedLicense === undefined || n > (licenseTally.get(expectedLicense) ?? 0)) {
    expectedLicense = l;
  }
}

for (const { dir, path, pkg } of manifests) {
  if (typeof pkg.license !== "string" || pkg.license === "") {
    errors.push(
      `${path}: missing "license". npm only WARNS, so this ships: a tarball ` +
        "with no license field is read as all-rights-reserved by registries " +
        "and by every downstream license scanner" +
        (expectedLicense === undefined ? "." : `. Expected: ${expectedLicense}`),
    );
  } else if (expectedLicense !== undefined && pkg.license !== expectedLicense) {
    errors.push(
      `${path}: license "${pkg.license}" disagrees with the other publishable ` +
        `packages ("${expectedLicense}"). One repo, one LICENSE file, so only ` +
        "one of these can be true.",
    );
  }

  // The FILE, which is a separate fact from the field. npm packs the LICENSE
  // in the package directory and never one from an ancestor, so the repo-root
  // copy reaches no tarball however correct the field is.
  if (!existsSync(join(ROOT, dir, "LICENSE"))) {
    errors.push(
      `${dir}/LICENSE does not exist. npm packs only the LICENSE inside the ` +
        "package directory, so the repo-root copy never reaches this " +
        "package's tarball — the field alone states terms it does not ship.",
    );
  }

  // `sideEffects: false` on a package that exports CSS. Optional field: absent
  // is the conservative default and always legal.
  // No record guard: `??` covers an absent `exports`, and the string form (a
  // single entry point, no subpaths) is read as the one path it names. All four
  // of these use the object form.
  const exportsField = pkg.exports;
  const subpaths =
    typeof exportsField === "string" ? [exportsField] : Object.keys(exportsField ?? {});
  const css = subpaths.filter((subpath) => subpath.endsWith(".css"));
  if (pkg.sideEffects === false && css.length > 0) {
    errors.push(
      `${path}: claims "sideEffects": false while exporting ${css.join(", ")}. ` +
        'A consumer\'s `import "…css"` is an import for EFFECT, and that claim ' +
        "lets a bundler drop it — no error, just an unstyled app. Name the css " +
        'instead: ["*.css", "**/*.css"].',
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
    `scope, name their repository, and ship ${expectedLicense ?? "a"} license terms.`,
);
