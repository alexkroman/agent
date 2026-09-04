// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-check something against the compiler a SCAFFOLDED PROJECT runs, rather
 * than the repo's.
 *
 * Two gates need this — `check-template-types` (the shipped templates) and
 * `check-doc-examples` (every ```ts fence in published docs) — and they need
 * it for the same reason: the repo's tsconfig and the scaffold's differ in both
 * directions (catch variables, `types`, `lib`, `jsx`), so `pnpm typecheck` can
 * be green while the code every user actually gets does not compile.
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
 * Each arm of the result names the other's key as absent, which is what makes
 * `if (result.ok)` narrow: on a bare `{ok:true} | {ok:false,output}` union the
 * `output` read in the else branch is an error, not a narrowing.
 *
 * @param {{ name: string, include: string[], overrides?: Record<string, unknown> }} opts
 * @returns {{ ok: true, output?: undefined } | { ok: false, output: string }}
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
    // stderr as well as stdout. tsc writes DIAGNOSTICS to stdout, but the two
    // ways this call fails for a reason that is not a diagnostic — a missing
    // `node_modules/.bin/tsc` (ENOENT, no output at all) and a config tsc
    // refuses to load — say so on stderr or in the spawn error. Discarding it
    // produced an empty diagnostic block under a heading like "a documentation
    // example does not compile", pointing the reader at the templates when the
    // problem was the toolchain.
    const stdout = String(err.stdout ?? "");
    const stderr = String(err.stderr ?? "");
    const spawnFailure = err.stdout === undefined && err.stderr === undefined ? String(err) : "";
    const output = [stdout, stderr, spawnFailure].filter((part) => part.trim() !== "").join("\n");
    return { ok: false, output };
  } finally {
    rmSync(configPath, { force: true });
  }
}
