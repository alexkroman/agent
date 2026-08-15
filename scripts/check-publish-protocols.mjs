#!/usr/bin/env node

/**
 * Proves no workspace-only version protocol reaches npm.
 *
 * `workspace:*` and `catalog:` are pnpm protocols. They are meaningless to
 * anyone installing from the registry — npm treats `"zod": "catalog:"` as an
 * unsatisfiable range and the install dies — so pnpm rewrites both to the
 * resolved version when it packs a tarball. That rewrite is the ONLY thing
 * standing between the catalog in `pnpm-workspace.yaml` and a broken release,
 * and it belongs to the packer, not to us: `changeset publish` picks its
 * publish command from the lockfile, so a future changesets release that
 * shelled out to `npm publish` instead would ship `catalog:` verbatim.
 *
 * The failure mode is what makes this worth a gate rather than a comment. It
 * cannot be caught by reading the diff (the manifests are correct — the
 * protocol is the intended source form), it cannot be caught by a build, and
 * it cannot be caught by `publint`, which reads the SOURCE manifest. It shows
 * up as a 100% broken published version, for every consumer, discovered by
 * consumers. Unpublishing inside 72 hours is the only remedy.
 *
 * So this packs each publishable package the way a release does and reads the
 * manifest back out of the tarball. It is the same move as the `pnpm pack`
 * behind `publint` — hence living beside it in the check pipeline — and it
 * asserts on the artifact rather than on the intent.
 */

import { join } from "node:path";

import { manifestInTarball, publishablePackages, repoRoot, withPackedTarball } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url);

/**
 * Protocols that must never survive into a tarball, and what each means when
 * one does. Both are pnpm-only: `npm install` fails outright on them.
 */
const FORBIDDEN = [
  { protocol: "workspace:", meaning: "an unresolved sibling-package link" },
  { protocol: "catalog:", meaning: "an unresolved pnpm-workspace.yaml catalog entry" },
];

/** Manifest fields npm resolves at install time. */
const VERSION_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** The three published packages — see check-publish-names.mjs for the scope rule. */
const publishable = publishablePackages(ROOT);

if (publishable.length === 0) {
  console.error(
    "check-publish-protocols: found no publishable packages — is the scan still right?",
  );
  process.exit(1);
}

const failures = [];

for (const dir of publishable) {
  // `withPackedTarball` owns the pack + scratch-directory dance, shared with
  // `artifact-size-report.mjs` — the only two things in the repo that pack.
  // Read the manifest straight out of the archive: extracting to disk first
  // would let a stale extraction from an earlier run answer instead.
  const manifest = withPackedTarball(join(ROOT, dir), ({ tarball }) => manifestInTarball(tarball));

  for (const field of VERSION_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      const hit = FORBIDDEN.find(({ protocol }) => String(range).startsWith(protocol));
      if (hit !== undefined) {
        failures.push({ dir, name, field, found: `${range} — ${hit.meaning}` });
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `\ncheck-publish-protocols: ${failures.length} unresolved workspace protocol(s) in packed tarballs:\n`,
  );
  for (const { dir, field, name, found } of failures) {
    console.error(`  ${dir}  ${field}.${name} = ${found}`);
  }
  console.error(
    "\nA tarball carrying one of these installs for nobody outside this workspace.\n" +
      "pnpm rewrites both protocols when it packs, so this means the pack path\n" +
      "changed — check that `changeset publish` still resolves to `pnpm publish`\n" +
      "and not `npm publish`.\n",
  );
  process.exit(1);
}

console.log(
  `check-publish-protocols: ${publishable.length} package(s) pack with every version resolved ` +
    `(${publishable.join(", ")}).`,
);
