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
 * failure mode being prevented is two configs disagreeing. That derivation,
 * and the reason the generated config has to sit at the repo root, live in
 * `_scaffold-tsc.mjs`, shared with `check-doc-examples.mjs`.
 *
 *   pnpm check:template-types
 */

import path from "node:path";
import { REPO_ROOT, runScaffoldTsc, SCAFFOLD_DIR } from "./_scaffold-tsc.mjs";

const result = runScaffoldTsc({
  name: "template-types",
  // `types` differs on purpose: a scaffolded project resolves `vitest/globals`
  // from its own install, and template tools use `node` builtins. Everything
  // that decides whether a given file type-checks — strictness, target, lib,
  // jsx — comes from the scaffold untouched.
  overrides: { types: ["vitest/globals", "node"] },
  include: [
    path.join(REPO_ROOT, "packages/aai-templates/templates/**/*.ts"),
    path.join(REPO_ROOT, "packages/aai-templates/templates/**/*.tsx"),
    // Carries the triple-slash reference to vite's client types, without
    // which every `?raw` and `.css` import in a template is an unresolved
    // module. (Spelled out rather than quoted: knip parses a verbatim
    // reference directive in a comment as a real dependency.)
    path.join(SCAFFOLD_DIR, "global.d.ts"),
  ],
});

if (result.ok) {
  console.log("check-template-types: every template type-checks under the scaffold config. ✓");
} else {
  process.stdout.write(result.output);
  console.error(
    "\ncheck-template-types: a template does not compile under the config users get.\n" +
      "`pnpm typecheck` can be green and this still fail — the repo's tsconfig is stricter\n" +
      "in some places and LOOSER in others (evolving-array inference, catch variables).",
  );
  process.exitCode = 1;
}
