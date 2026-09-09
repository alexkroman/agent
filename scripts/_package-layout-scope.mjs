// Copyright 2026 the AAI authors. MIT license.
/**
 * What `check-package-layout.mjs` DECIDES, with no I/O in it.
 *
 * Its own module for `_deploy-changeset-scope.mjs`'s reason, arriving by the
 * route that module's doc predicts. `packages/aai-gates/src/package-layout-gate.test.ts`
 * asserts that the tree really satisfies the gate, and it did so against a
 * RESTATEMENT of the exemptions:
 *
 * ```js
 * return !(parts[1] === "aai-templates" && ["templates", "scaffold"].includes(parts[2] ?? ""));
 * ```
 *
 * — a hand-kept second copy of `PRODUCT_TREES` and `ROOT_CONFIGS`, in the one
 * place whose job is to check them. So declaring a new product tree failed the
 * gate's own spec, and that failure said nothing about whether the declaration
 * was right: the two lists had simply diverged. Which is exactly what
 * `isAllowedOutsideSrc`'s doc says the export exists to prevent — "so the gate's
 * spec can drive the decision directly rather than re-deriving it from the
 * report". It could not, because importing the gate would drag `node:fs` and
 * `node:child_process` into a package whose tsconfig has no node types.
 *
 * Nothing here imports anything, which is the property that makes the import
 * legal from that package. The gate script owns every read: git, the tree, and
 * the floors.
 */

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
 * Per package AND per directory on purpose. A repo-wide glob would silently
 * exempt any future directory that happened to take the name, which is the
 * shape of exemption `guard-invariants` records paying for four times.
 */
export const PRODUCT_TREES = {
  "aai-templates": ["templates", "scaffold"],
};

/**
 * Whether a repo-relative TypeScript path is allowed to sit outside `src/`.
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
