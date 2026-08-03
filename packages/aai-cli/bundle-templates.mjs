// Copyright 2026 the AAI authors. MIT license.
/**
 * Copy the agent templates into the CLI's `dist/`, so they ship inside the
 * published tarball.
 *
 * `aai init` used to fetch them at runtime with giget
 * (`github:alexkroman/agent/packages/aai-templates#main`). That had two
 * problems. It pinned the CLI to a *network* — no offline `init` — and it
 * fetched from `main` while the user ran a pinned CLI version, so a template
 * written against a newer SDK could land in a project resolving an older one.
 * And a second consumer appeared that has no fetch path at all: the studio's
 * coding agent, which runs in a guest sandbox with `@alexkroman1/aai-cli`
 * baked into its toolchain `node_modules` but no checkout of this repo.
 * Shipping the files in the tarball serves both.
 *
 * The sources stay in `packages/aai-templates/` — that package owns their
 * tests, type checks, and lint config. This is a packaging step, not a move.
 * `packages/aai-cli/turbo.json` adds those sources to the build's `inputs`,
 * so editing a template invalidates the CLI build rather than replaying a
 * cache that predates it.
 */

import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/** Directories copied from the templates package into `dist/`. */
const BUNDLED_DIRS = ["templates", "scaffold"];

const require = createRequire(import.meta.url);
// Resolve through the package graph rather than a relative `../aai-templates`
// walk: the same drift that made studio-prompt.ts silently serve its fallback
// guide in production applies to any hand-written path between packages.
const templatesRoot = path.dirname(require.resolve("aai-templates/package.json"));
const distDir = path.join(import.meta.dirname, "dist");

for (const dir of BUNDLED_DIRS) {
  const dest = path.join(distDir, dir);
  await rm(dest, { recursive: true, force: true });
  await cp(path.join(templatesRoot, dir), dest, { recursive: true });
}

console.log(`Bundled ${BUNDLED_DIRS.join(", ")} into ${path.relative(process.cwd(), distDir)}`);
