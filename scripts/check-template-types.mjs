// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-check every template under the SCAFFOLD's tsconfig — the one a user
 * actually gets from `aai init` — rather than the repo's.
 *
 * The two are not the same compiler, and the difference hides real bugs. The
 * repo builds templates under its own strict config; a scaffolded project runs
 * with `useUnknownInCatchVariables: false` and a different `types`/`lib` set,
 * so code the repo type-checks cleanly can still fail for every user who
 * scaffolds it.
 *
 * That is not hypothetical: this check found two `never[]` pushes in the
 * shipped `solo-rpg` client while `pnpm typecheck` stayed green. Those came
 * from the scaffold ALSO setting `noImplicitAny: false`, which disables
 * evolving-array inference — a setting since reversed (see
 * `studio-project-shape.ts`), and the gap it opened is the reason this gate
 * exists rather than a reason it can now be retired: the two configs still
 * differ, and the next divergence will not announce itself either.
 *
 * The config is DERIVED from `scaffold/tsconfig.json` at run time rather than
 * copied, so the check cannot drift from what it claims to verify — the whole
 * failure mode being prevented is two configs disagreeing. That derivation,
 * and the reason the generated config has to sit at the repo root, live in
 * `_scaffold-tsc.mjs`, shared with `check-doc-examples.mjs`.
 *
 * **`scaffold/server.mjs` is checked here too, and was checked by NOTHING.** It
 * is the server every `aai init` project runs, and no tsconfig in the repo set
 * `allowJs`, so the first code a new user executes had lint and no compiler.
 * Deriving the config is what makes this the right home: the alternative is
 * setting `checkJs` in `scaffold/tsconfig.json`, which SHIPS — it would turn on
 * JS checking inside every user's project to suit a gate in ours. The
 * `allowJs`/`checkJs` pair is an override here for that reason, and `checkJs` is
 * the half that matters: `allowJs` alone only lets the file be pulled in as an
 * import.
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
  overrides: { types: ["vitest/globals", "node"], allowJs: true, checkJs: true },
  include: [
    path.join(REPO_ROOT, "packages/aai-templates/templates/**/*.ts"),
    path.join(REPO_ROOT, "packages/aai-templates/templates/**/*.tsx"),
    // Carries the triple-slash reference to vite's client types, without
    // which every `?raw` and `.css` import in a template is an unresolved
    // module. (Spelled out rather than quoted: knip parses a verbatim
    // reference directive in a comment as a real dependency.)
    path.join(SCAFFOLD_DIR, "global.d.ts"),
    // The shipped server entrypoint. Named as a FILE rather than a `*.mjs` glob:
    // the scaffold holds exactly one, and a glob would silently start checking
    // whatever else lands beside it under a config chosen for this file.
    path.join(SCAFFOLD_DIR, "server.mjs"),
    // The scaffold's two shipped CONFIGS, for the reason `server.mjs` is here:
    // a user gets them from `aai init` and every `aai test` / `aai dev` loads
    // them, and they were checked by NOTHING — `packages/aai-templates/tsconfig.json`
    // deliberately stops at `src` so the scaffold is checked here instead, and
    // here only named `global.d.ts` and `server.mjs`. Confirmed by putting
    // `const x: number = "s"` in each and watching all four type gates stay green.
    //
    // `vitest.config.ts` is the one that can actually rot: it imports
    // `@alexkroman1/aai/testing/vite` for `aaiAgentPlugin`, so a rename on OUR
    // side of that subpath breaks every scaffolded project's test run, and this
    // is the only place that would say so. `vite.config.ts` names
    // `@tailwindcss/vite` and `@vitejs/plugin-react`, which is why this package
    // now carries both — the alternative was leaving the file unchecked.
    //
    // Named as FILES, not a `*.config.ts` glob, for the same reason as
    // `server.mjs`: the scaffold holds exactly these two.
    path.join(SCAFFOLD_DIR, "vite.config.ts"),
    path.join(SCAFFOLD_DIR, "vitest.config.ts"),
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
