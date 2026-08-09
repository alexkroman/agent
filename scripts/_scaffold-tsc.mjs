// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-check something against the compiler a SCAFFOLDED PROJECT runs, rather
 * than the repo's.
 *
 * Two gates need this — `check-template-types` (the shipped templates) and
 * `check-doc-examples` (every ```ts fence in published docs) — and they need
 * it for the same reason: the repo's tsconfig is stricter in some places and
 * LOOSER in others (evolving-array inference under `noImplicitAny: false`,
 * catch variables), so `pnpm typecheck` can be green while the code every
 * user actually gets does not compile.
 *
 * Both derive the config from `scaffold/tsconfig.json` at run time rather than
 * copying it — the whole failure mode being prevented is two configs
 * disagreeing — and both write it AT THE REPO ROOT, because `types` and
 * `typeRoots` resolve relative to the tsconfig's own directory, so a config in
 * a temp dir cannot find `node` or `vitest/globals` no matter what the paths
 * inside it say. That pair of constraints is what lives here.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the repository root. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The scaffold `aai init` ships — the project layout being type-checked against. */
export const SCAFFOLD_DIR = path.join(REPO_ROOT, "packages/aai-templates/scaffold");

/** The scaffold's own `compilerOptions`, read fresh so this cannot drift from it. */
export function scaffoldCompilerOptions() {
  return JSON.parse(readFileSync(path.join(SCAFFOLD_DIR, "tsconfig.json"), "utf-8"))
    .compilerOptions;
}

/**
 * Run `tsc --noEmit` over `include` with the scaffold's compiler options plus
 * `overrides`, and always remove the generated config afterwards.
 *
 * Returns `{ ok: true }` or `{ ok: false, output }` — the caller owns its own
 * messaging, including any rewriting of scratch paths in the diagnostics back
 * to whatever the reader should be looking at.
 *
 * @param {{ name: string, include: string[], overrides?: Record<string, unknown> }} opts
 */
export function runScaffoldTsc({ name, include, overrides = {} }) {
  const configPath = path.join(REPO_ROOT, `tsconfig.${name}.json`);
  const config = {
    compilerOptions: { ...scaffoldCompilerOptions(), noEmit: true, ...overrides },
    include,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  try {
    execFileSync(path.join(REPO_ROOT, "node_modules/.bin/tsc"), ["-p", configPath], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, output: String(err.stdout ?? "") };
  } finally {
    rmSync(configPath, { force: true });
  }
}
