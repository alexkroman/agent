#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.
/**
 * Package-layout gate: a package's TypeScript lives under `src/`.
 *
 * The repo had no source root. Every package kept its modules directly in the
 * package directory, mixed in with `package.json`, the tsconfigs, the vitest
 * config, `CHANGELOG.md`, `etc/`, `contracts/` and (in two packages) shipped
 * product trees — 1,093 top-level entries across nine packages, 292 of them in
 * `aai-server` alone. That is not a style complaint; three concrete failures
 * came out of it, and they are the reason this gate exists rather than a
 * paragraph in a guide:
 *
 * - **`rootDir` had to be the package.** So `tsc -p tsconfig.build.json`
 *   emitted a `.d.ts` for every repo artifact that happened to be TypeScript,
 *   and `aai-ui`'s `files: ["dist"]` SHIPPED the frozen compatibility examples
 *   until an `exclude` list was written by hand and kept current. With
 *   `rootDir: "src"` the exclusion is structural.
 * - **Every path-keyed tool had to enumerate directories.** konsistent's
 *   boundary conventions named `host/`, `sdk/`, `components/`, `worklets/`,
 *   `integration/`, `providers/`, `telephony/`, `transports/` one at a time —
 *   the set that existed when each was written — so a new directory defaulted
 *   OUT of the check that was supposed to cover the package. Collapsing them
 *   to `src/**` took the boundary corpus from 1,591 files to 1,696.
 * - **`packages/**\/*.ts` worked by accident.** The root guide says so in as
 *   many words: it matched because "every source file there is at least one
 *   directory deep". A git pathspec is fnmatch WITHOUT `FNM_PATHNAME`, and this
 *   repo has already paid twice for that (`scripts/**\/*.mjs` measured nothing
 *   at the top level for as long as it existed). A source root makes the
 *   accident an invariant.
 *
 * ## What it checks
 *
 * One rule, stated twice from opposite sides so neither half can rot alone:
 *
 * 1. **No `.ts`/`.tsx` outside `src/`**, except the package-root build and test
 *    configs ({@link ROOT_CONFIGS}) and the declared product trees
 *    ({@link PRODUCT_TREES}).
 * 2. **Every package HAS a `src/`**, and it is not empty.
 *
 * The second is what keeps the first honest. A rule of the form "no X outside
 * Y" is vacuously true when Y is where everything already is *and* when the
 * package has been emptied — and the failure this repo keeps rediscovering is
 * exactly the gate whose success output is indistinguishable from a gate that
 * measured nothing. Hence the {@link MIN_PACKAGES} and {@link MIN_FILES} floors
 * as well: a corpus that stops resolving FAILS instead of printing a checkmark.
 *
 * ## What is deliberately NOT under `src/`
 *
 * `ROOT_CONFIGS` is a fixed list rather than a pattern, because a config at the
 * package root is what every tool in the toolchain looks for by name — vitest,
 * tsdown, vite and tsc all resolve theirs from the package directory, and
 * moving them under `src/` would mean configuring each one to look elsewhere.
 *
 * `PRODUCT_TREES` is the narrow exemption, and it is per PACKAGE and per
 * DIRECTORY rather than a glob, so adding one is a reviewable line. Both
 * entries are shipped artifacts rather than this repo's own source: the agent
 * templates a user gets from `aai init`, and the scaffold merged underneath
 * them. Their TypeScript is authored FOR a user's project — it resolves
 * `@alexkroman1/aai` from the user's node_modules, is type-checked under the
 * SCAFFOLD's looser tsconfig by `check:template-types`, and is exempt from most
 * of biome. Putting it under this package's `src/` would claim it as code this
 * package builds, which is the opposite of true.
 *
 * Wired up as `pnpm check:package-layout`, in `scripts/check.mjs` and in
 * `.github/workflows/check.yml`. `packages/aai-templates/src/package-layout-gate.test.ts`
 * is the spec: it proves the gate FAILS on a violation, because a gate that has
 * never failed is indistinguishable from one that cannot.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseScriptArgs } from "./_args.mjs";
import { repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url);

/**
 * Config files a package keeps at its root, by exact name.
 *
 * Not a pattern: each of these is resolved BY NAME from the package directory
 * by a tool that is not ours (vitest, tsdown, vite, tsc, turbo), so the list is
 * a statement about those tools rather than a convention we could relax.
 */
export const ROOT_CONFIGS = new Set(["vitest.config.ts", "vite.config.ts", "tsdown.config.ts"]);

/**
 * Directories whose TypeScript is a shipped product rather than this repo's
 * source, keyed by package.
 *
 * Per package AND per directory on purpose. A repo-wide glob (`**\/templates/**`)
 * would silently exempt any future directory that happened to take the name,
 * which is the shape of exemption `guard-invariants` records paying for four
 * times.
 */
export const PRODUCT_TREES = {
  "aai-templates": ["templates", "scaffold"],
};

/** A corpus this far below the real tree means the scan stopped resolving. */
export const MIN_PACKAGES = 8;
/** Likewise for files: the tree holds ~1,750 under `src/`. */
export const MIN_FILES = 1200;

/**
 * Whether a repo-relative TypeScript path is allowed to sit outside `src/`.
 *
 * Exported so the gate's spec can drive the decision directly rather than
 * re-deriving it from the report — the same reason `_deploy-changeset-scope.mjs`
 * exports `isShippedSource`.
 *
 * @param {string} file - repo-relative path, `/`-separated
 * @returns {boolean}
 */
export function isAllowedOutsideSrc(file) {
  const [, pkg, ...rest] = file.split("/");
  if (pkg === undefined || rest.length === 0) return false;
  if (rest.length === 1 && ROOT_CONFIGS.has(rest[0])) return true;
  const trees = PRODUCT_TREES[pkg] ?? [];
  return trees.includes(rest[0]);
}

/** Every git-tracked `.ts`/`.tsx` under `packages/`. */
function trackedTypeScript() {
  const out = execFileSync("git", ["ls-files", "--", "packages"], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\n").filter((f) => /\.tsx?$/.test(f));
}

/** Package directory names under `packages/`, from git rather than a walk. */
function packageDirs(files) {
  return [...new Set(files.map((f) => f.split("/")[1]).filter(Boolean))].sort();
}

function main() {
  parseScriptArgs({ script: import.meta.url, options: {} });

  const files = trackedTypeScript();
  const packages = packageDirs(files);
  const problems = [];

  // The floors first: everything below is a comparison, and a comparison over
  // an empty corpus reports no violations and exits 0.
  if (packages.length < MIN_PACKAGES) {
    problems.push(
      `only ${packages.length} package(s) found (floor ${MIN_PACKAGES}). The scan stopped ` +
        "resolving — `git ls-files -- packages` returned almost nothing.",
    );
  }
  if (files.length < MIN_FILES) {
    problems.push(
      `only ${files.length} TypeScript file(s) found (floor ${MIN_FILES}). The scan stopped ` +
        "resolving; this gate cannot report anything useful until that is fixed.",
    );
  }

  const stray = files.filter((f) => {
    const parts = f.split("/");
    return parts[2] !== "src" && !isAllowedOutsideSrc(f);
  });

  const noSrc = packages.filter((pkg) => !files.some((f) => f.startsWith(`packages/${pkg}/src/`)));

  if (stray.length > 0) {
    problems.push(
      `${stray.length} TypeScript file(s) outside a package's \`src/\`:\n` +
        stray.map((f) => `    ${f}`).join("\n") +
        "\n\n  Source belongs in `packages/<pkg>/src/`. A package-root config is\n" +
        "  allowed by name (vitest/vite/tsdown); a shipped product tree is declared\n" +
        "  in PRODUCT_TREES in scripts/check-package-layout.mjs, with a reason.",
    );
  }
  if (noSrc.length > 0) {
    problems.push(
      `${noSrc.length} package(s) with no \`src/\`: ${noSrc.join(", ")}.\n` +
        "  Every package's source root is `src/` — konsistent's `workspace-package-layout`\n" +
        "  requires the directory, and this is the half that requires it to hold code.",
    );
  }

  // A `src/` that git tracks but the filesystem does not is the worktree half
  // of the same claim, and costs one stat per package.
  for (const pkg of packages) {
    if (noSrc.includes(pkg)) continue;
    if (!existsSync(join(ROOT, "packages", pkg, "src"))) {
      problems.push(`packages/${pkg}/src is tracked by git but missing from the working tree.`);
    }
  }

  if (problems.length > 0) {
    console.error(`check-package-layout: ${problems.length} problem(s).\n`);
    for (const problem of problems) console.error(`  ${problem}\n`);
    process.exit(1);
  }

  console.log(
    `check-package-layout: ${files.length} TypeScript file(s) across ${packages.length} ` +
      "package(s), all under `src/` (or a declared root config / product tree). ✓",
  );
}

main();
