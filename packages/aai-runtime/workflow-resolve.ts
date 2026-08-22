// Copyright 2026 the AAI authors. MIT license.
/**
 * **Never hand the DevKit a bare specifier.** One helper, because this class of
 * bug has now been paid for three times.
 *
 * The DevKit loads code from files whose LOCATION we do not choose — its own
 * compiled artifacts land in `tmpdir()`, and so do the route modules
 * `workflow-serve.ts` writes. A bare specifier is resolved relative to the
 * importing file, so from any of those there is no `node_modules` above it and
 * the load fails naming a module that is plainly installed:
 *
 * ```text
 * Cannot find module '@workflow/world-postgres'
 * Require stack:
 * - /private/var/folders/…/T/index.js
 * ```
 *
 * Every fix for it is the same move — resolve the specifier HERE, in a module
 * that sits in a real dependency tree, and pass the absolute result on. What
 * differs is only the mechanism the DevKit will load it with, which is why this
 * module exposes two:
 *
 * - {@link resolveWorldSpecifier} for a value the DevKit `require`s (the
 *   `WORKFLOW_TARGET_WORLD` env var), which needs an absolute PATH.
 * - {@link resolveImportSpecifier} for one it `import`s (the static specifiers
 *   `rewriteWorkflowImports` rewrites), which needs a file URL.
 *
 * The alternative — writing those files somewhere with a usable `node_modules`
 * above them — was considered and is strictly weaker: it bets on a writable
 * install directory, and it cannot work at all for the DevKit's OWN artifacts,
 * whose path is not ours to pick.
 *
 * **Resolution failure leaves the specifier ALONE**, in both directions. It then
 * fails at load with Node's own error naming the module, which reports a genuine
 * packaging problem far better than an absolute path that resolves to nothing.
 */

import { createRequire } from "node:module";

/**
 * Resolve a specifier the way `require` will, to an absolute PATH.
 *
 * `createRequire` rather than `import.meta.resolve` because the CALLER's
 * mechanism decides: the DevKit reads `WORKFLOW_TARGET_WORLD` and `require`s it,
 * so the require export conditions are the ones that must apply, and `require`
 * takes a path rather than a URL.
 *
 * @internal
 */
export function resolveWorldSpecifier(specifier: string): string {
  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch {
    // Left as it was: Node's own "Cannot find module" names the package, which is
    // the right report for a world that genuinely is not installed.
    return specifier;
  }
}

/**
 * Resolve a specifier the way `import` will, to an absolute file URL.
 *
 * `import.meta.resolve`, NOT `createRequire(...).resolve`, and the difference has
 * bitten: the two apply different export conditions, and `workflow`'s root entry
 * maps `require` to its TYPESCRIPT PLUGIN — so the require form rewrote
 * `import … from "workflow"` to a CJS plugin that then failed loading
 * `typescript/lib/tsserverlibrary`. A step bundle is ESM and its imports must
 * resolve the way an import does.
 *
 * @internal
 */
export function resolveImportSpecifier(specifier: string): string | undefined {
  try {
    return import.meta.resolve(specifier);
  } catch {
    return undefined;
  }
}
