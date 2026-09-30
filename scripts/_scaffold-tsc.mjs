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
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the repository root. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The scaffold `aai init` ships — the project layout being type-checked against. */
export const SCAFFOLD_DIR = path.join(REPO_ROOT, "packages/aai-templates/scaffold");

/**
 * Vite's client types (`vite/client`) as an absolute path, resolved from the
 * scaffold's package the way a scaffolded project resolves them from its own
 * install.
 *
 * The preset names `vite/client` in `types`, and a `types` entry resolves from
 * the CONFIG's directory — the repo root here (see the module doc), whose
 * `node_modules` has no `vite`. A path entry is resolved as a file instead.
 */
export const VITE_CLIENT_TYPES = path.join(
  path.dirname(
    createRequire(path.join(SCAFFOLD_DIR, "..", "package.json")).resolve("vite/package.json"),
  ),
  "client",
);

/**
 * The scaffold's `tsconfig.json`, read fresh so this cannot drift from it: its
 * own `compilerOptions`, and the preset it `extends`
 * (`@alexkroman1/aai/tsconfig`) resolved to an ABSOLUTE path the way the
 * scaffold's own `tsc` resolves it — through the SDK's `exports` map, from the
 * scaffold's directory. The generated config extends that same file, so the
 * preset's options AND its `files` entry (`presets/agent-env.d.ts`, the
 * `virtual:aai/agent` declaration) reach every program checked here.
 */
export function scaffoldTsconfig() {
  const parsed = JSON.parse(readFileSync(path.join(SCAFFOLD_DIR, "tsconfig.json"), "utf-8"));
  const extendsPath =
    typeof parsed.extends === "string"
      ? createRequire(path.join(SCAFFOLD_DIR, "package.json")).resolve(parsed.extends)
      : undefined;
  return { extends: extendsPath, compilerOptions: parsed.compilerOptions ?? {} };
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
  const scaffold = scaffoldTsconfig();
  const config = {
    // `JSON.stringify` drops an `undefined` value, so no preset writes no key.
    extends: scaffold.extends,
    compilerOptions: { ...scaffold.compilerOptions, noEmit: true, ...overrides },
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
    const out = err instanceof Error && "stdout" in err ? err.stdout : undefined;
    const errOut = err instanceof Error && "stderr" in err ? err.stderr : undefined;
    const stdout = String(out ?? "");
    const stderr = String(errOut ?? "");
    const spawnFailure = out === undefined && errOut === undefined ? String(err) : "";
    const output = [stdout, stderr, spawnFailure].filter((part) => part.trim() !== "").join("\n");
    return { ok: false, output };
  } finally {
    rmSync(configPath, { force: true });
  }
}
