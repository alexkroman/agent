// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-check every template under the SCAFFOLD's tsconfig — the one a user
 * actually gets from `aai init` — rather than the repo's.
 *
 * The two are not the same compiler, and the difference hides real bugs. The
 * repo builds templates under its own strict config; a scaffolded project
 * runs with `noImplicitAny: false` and `useUnknownInCatchVariables: false`.
 * Turning `noImplicitAny` off disables TypeScript's evolving-array inference,
 * so `const xs = []` is `never[]` from the declaration rather than widening
 * from later pushes — which means code the repo type-checks cleanly can fail
 * for every user who scaffolds it.
 *
 * That is not hypothetical: this check found exactly that in the shipped
 * `solo-rpg` client, twice (`const pips = []` / `const segments = []`, both
 * pushed JSX). `pnpm typecheck` was green the whole time, because the repo's
 * config makes those legal.
 *
 * The config is DERIVED from `scaffold/tsconfig.json` at run time rather than
 * copied, so the check cannot drift from what it claims to verify — the whole
 * failure mode being prevented is two configs disagreeing.
 *
 *   pnpm check:template-types
 */

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scaffoldDir = path.join(repo, "packages/aai-templates/scaffold");
const scaffold = JSON.parse(readFileSync(path.join(scaffoldDir, "tsconfig.json"), "utf-8"));

/**
 * `types` differs on purpose: a scaffolded project resolves `vitest/globals`
 * from its own install, and template tools use `node` builtins. Everything
 * that decides whether a given file type-checks — strictness, target, lib,
 * jsx — comes from the scaffold untouched.
 */
const config = {
  compilerOptions: { ...scaffold.compilerOptions, types: ["vitest/globals", "node"], noEmit: true },
  include: [
    path.join(repo, "packages/aai-templates/templates/**/*.ts"),
    path.join(repo, "packages/aai-templates/templates/**/*.tsx"),
    // Carries the triple-slash reference to vite's client types, without
    // which every `?raw` and `.css` import in a template is an unresolved
    // module. (Spelled out rather than quoted: knip parses a verbatim
    // reference directive in a comment as a real dependency.)
    path.join(scaffoldDir, "global.d.ts"),
  ],
};

/**
 * Written at the repo root, not a temp dir: `types` and `typeRoots` resolve
 * relative to the tsconfig's own location, so a config in /tmp cannot find
 * `node` or `vitest/globals` no matter what the paths inside it say.
 */
const configPath = path.join(repo, "tsconfig.template-types.json");
writeFileSync(configPath, JSON.stringify(config, null, 2));

try {
  execFileSync(path.join(repo, "node_modules/.bin/tsc"), ["-p", configPath], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  console.log("check-template-types: every template type-checks under the scaffold config. ✓");
} catch (err) {
  process.stdout.write(String(err.stdout ?? ""));
  console.error(
    "\ncheck-template-types: a template does not compile under the config users get.\n" +
      "`pnpm typecheck` can be green and this still fail — the repo's tsconfig is stricter\n" +
      "in some places and LOOSER in others (evolving-array inference, catch variables).",
  );
  process.exitCode = 1;
} finally {
  rmSync(configPath, { force: true });
}
