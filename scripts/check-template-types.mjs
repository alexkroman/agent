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
 * shipped `tabletop-rpg-agent` client while `pnpm typecheck` stayed green. Those came
 * from the scaffold ALSO setting `noImplicitAny: false`, which disables
 * evolving-array inference — a setting since reversed (see
 * `studio/project-shape.ts`), and the gap it opened is the reason this gate
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
import { REPO_ROOT, runScaffoldTsc, SCAFFOLD_DIR, VITE_CLIENT_TYPES } from "./_scaffold-tsc.mjs";

const include = [
  path.join(REPO_ROOT, "packages/aai-templates/templates/**/*.ts"),
  path.join(REPO_ROOT, "packages/aai-templates/templates/**/*.tsx"),
  // The shipped server entrypoint. Named as a FILE rather than a `*.mjs` glob:
  // the scaffold holds exactly one, and a glob would silently start checking
  // whatever else lands beside it under a config chosen for this file.
  path.join(SCAFFOLD_DIR, "server.mjs"),
  // The scaffold's shipped CONFIG, for the reason `server.mjs` is here: a
  // user gets it from `aai init` and every `aai test` loads it, and it was
  // checked by NOTHING — `packages/aai-templates/tsconfig.json` deliberately
  // stops at `src` so the scaffold is checked here instead. Confirmed by
  // putting `const x: number = "s"` in it and watching all four type gates
  // stay green.
  //
  // It can rot: it imports `defineAgentTestConfig` from
  // `@alexkroman1/aai/testing/vite`, so a rename on OUR side of that subpath
  // breaks every scaffolded project's test run, and this is the only place
  // that would say so. (There is no scaffold `vite.config.ts` any more: the
  // CLI supplies the client plugins — `aai-cli/src/_client-plugins.ts`.)
  //
  // Named as a FILE, not a `*.config.ts` glob, for the same reason as
  // `server.mjs`. The `virtual:aai/agent` declaration needs no line: the
  // generated config extends the scaffold's preset, whose `files` carries it.
  path.join(SCAFFOLD_DIR, "vitest.config.ts"),
];

// `types` differs on purpose: the preset's `vitest/globals` and `vite/client`
// (the latter is what types every `?raw`, `.css` and `import.meta.glob` in a
// template), plus `node`, which template tools use. Everything that decides
// whether a given file type-checks — strictness, target, lib, jsx — comes from
// the scaffold untouched.
const overrides = {
  types: ["vitest/globals", VITE_CLIENT_TYPES, "node"],
  allowJs: true,
  checkJs: true,
};

/**
 * Two passes. The first is the config `aai init` ships, verbatim. The second
 * is that config plus the strictest flag a CONSUMER can turn on that the
 * scaffold leaves off: `exactOptionalPropertyTypes`. It is the flag the
 * capability-contract compatibility probe (`_api-contracts-compat.mjs`)
 * compiles under, so a published type that only breaks for a user who enables
 * it — an optional field a template legitimately fills with `undefined` — was
 * never compiled against a real consumer anywhere.
 *
 * It is an OVERLAY rather than a scaffold setting on purpose: turning it on in
 * `scaffold/tsconfig.json` ships it into every user's project, which is a
 * product decision about how strict a beginner's first agent should be, not a
 * gate's. `noUncheckedIndexedAccess` needs no second pass — the scaffold
 * already sets it.
 */
const passes = [
  {
    name: "template-types",
    label: "the scaffold config",
    overrides,
    hint:
      "`pnpm typecheck` can be green and this still fail — the repo's tsconfig is stricter\n" +
      "in some places and LOOSER in others (evolving-array inference, catch variables).",
  },
  {
    name: "template-types-strict",
    label: "the scaffold config + exactOptionalPropertyTypes",
    overrides: { ...overrides, exactOptionalPropertyTypes: true },
    hint:
      "A consumer who enables the flag gets this error. When it points at an SDK type (an\n" +
      "optional field a caller legitimately passes `undefined` to), fix the PUBLISHED type\n" +
      "(`?: T | undefined`) rather than working around it in the template.",
  },
];

for (const pass of passes) {
  const result = runScaffoldTsc({ name: pass.name, overrides: pass.overrides, include });
  if (result.ok) {
    console.log(`check-template-types: every template type-checks under ${pass.label}. ✓`);
    continue;
  }
  process.stdout.write(result.output);
  console.error(
    `\ncheck-template-types: a template does not compile under ${pass.label}.\n${pass.hint}`,
  );
  process.exitCode = 1;
}
