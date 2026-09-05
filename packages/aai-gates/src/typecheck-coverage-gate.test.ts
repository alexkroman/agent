// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Every TypeScript file in the repo belongs to some `tsc` program.
 *
 * There is no `check-typecheck-coverage.mjs` behind this one: the thing being
 * guarded is a set of `include` globs, and a glob is text, which is what a gate
 * spec here reads best. What it exists for is a failure the repo hit four
 * separate times, always the same way and always silently —
 *
 * `pnpm typecheck` runs one `tsc` per package and each package's `include` only
 * sets ROOT files, so a file no included root imports is in no program at all.
 * Nothing reports that. `turbo run typecheck` prints `17 successful`, `biome`
 * has no type opinion, and the file goes on looking checked because it sits
 * beside sixty that are. Measured by putting `const x: number = "s"` in ten of
 * them at once and watching all four type gates stay green.
 *
 * The four, and why they are one bug rather than four:
 *
 * - `aai-studio-client/tsconfig.json` named `vite.config.ts` ONE BY ONE and had
 *   fallen behind, so `vitest.config.ts` beside it was unchecked.
 * - `aai-gates/tsconfig.json` — this package — globbed `["src"]` only, and its
 *   own `vitest.config.ts` sits at the package root.
 * - `tsconfig.tools.json` claims root `*.ts` and `tsconfig.scripts.json` claims
 *   `scripts/**` and `examples/**`, so a `.mjs` at the ROOT (both Stryker
 *   configs) and a `.ts` under `scripts/` (five load-test agent sources) fell
 *   between them.
 * - `packages/aai-templates/scaffold/` is checked by `check:template-types`
 *   rather than by a tsconfig, and that gate named `global.d.ts` and
 *   `server.mjs` — not the two shipped configs beside them.
 *
 * The through-line is that a package root is where CONFIG lives, and config is
 * imported by nothing. `check-package-layout.mjs` makes that exact category its
 * one exemption from the `src/` rule ({@link ROOT_CONFIGS} there), so the files
 * it waves past are precisely the files a `["src"]` include cannot reach. The
 * two gates have to agree, and this is the half that says so.
 *
 * Assertions read the configs as TEXT, as every spec here does: this package's
 * tsconfig declares no node types, so a spec cannot spawn `tsc --listFiles`.
 * That is a real limit and worth naming — this checks that the GLOBS reach the
 * files, not that `tsc` accepted them. The compiler's own verdict is
 * `turbo run typecheck` plus the three root programs, which CI runs on the line
 * `ci-gate-job.test.ts` pins.
 */

import { describe, expect, test } from "vitest";
import { repoPathOf, sole } from "./_gate-support.ts";

/**
 * The config files a package may keep at its root.
 *
 * Duplicated from `scripts/check-package-layout.mjs` rather than imported — the
 * rule this package's guide states, and the same reason `byCodeUnit` is
 * duplicated: a gate spec may not import the script it guards. The test below
 * asserts the two lists are still the same, so the copy cannot drift silently.
 */
const ROOT_CONFIGS = ["vitest.config.ts", "vite.config.ts", "tsdown.config.ts"];

/** Every package tsconfig, keyed by package directory name. */
const packageTsconfigs = Object.fromEntries(
  Object.entries(
    import.meta.glob("../../*/tsconfig.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([key, text]) => [repoPathOf(key).split("/")[1] ?? "", text as string]),
);

/** The root-level config files each package actually has on disk. */
const rootConfigsPresent = Object.keys(
  import.meta.glob("../../*/{vitest,vite,tsdown}.config.ts"),
).map(repoPathOf);

const layoutGate = sole(
  import.meta.glob("../../../scripts/check-package-layout.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
) as string | undefined;

/**
 * The `include` array of a JSONC tsconfig, as raw entries.
 *
 * A regex rather than a parse because these files carry comments — and the
 * comments are load-bearing here, several of them arguing for the very glob
 * being read.
 */
function includeEntries(text: string): string[] {
  const block = /"include"\s*:\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

/** Whether an `include` entry reaches a file sitting directly at the package root. */
function reachesPackageRoot(entry: string, filename: string): boolean {
  if (entry === filename) return true;
  // `*.ts` / `*.tsx` at the root, and the recursive forms that also cover it.
  const ext = filename.slice(filename.lastIndexOf("."));
  return entry === `*${ext}` || entry === `./**/*${ext}` || entry === `**/*${ext}`;
}

describe("typecheck coverage", () => {
  test("the configs this gate reads all resolve", () => {
    // Every assertion below is a search over these strings; an unresolved glob
    // would make each one a search of nothing, which passes for `not.toContain`
    // and for an `every` over an empty list. This is the check that the corpus
    // exists at all.
    expect(Object.keys(packageTsconfigs).length).toBeGreaterThanOrEqual(10);
    expect(rootConfigsPresent.length).toBeGreaterThanOrEqual(10);
    expect(layoutGate).toBeTypeOf("string");
    for (const [pkg, text] of Object.entries(packageTsconfigs)) {
      expect(includeEntries(text), `packages/${pkg} has no include array`).not.toEqual([]);
    }
  });

  test("the ROOT_CONFIGS copy still matches check-package-layout.mjs", () => {
    // The duplication is deliberate (see the constant), so it needs a tie. If
    // the layout gate starts exempting a fourth root config, this list has to
    // learn about it or the new one becomes the next unchecked file.
    for (const name of ROOT_CONFIGS) {
      expect(layoutGate ?? "").toContain(`"${name}"`);
    }
    const declared = /ROOT_CONFIGS = new Set\(\[([^\]]*)\]\)/.exec(layoutGate ?? "")?.[1] ?? "";
    expect([...declared.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(ROOT_CONFIGS);
  });

  test("every package's root config file is reached by its own tsconfig include", () => {
    // THE regression this file exists for. `aai-studio-client` listed
    // `vite.config.ts` by name and missed `vitest.config.ts`; `aai-gates`
    // globbed `["src"]` and missed its own. Both were type-checked by no
    // program in the repo, and both looked completely ordinary in review.
    const orphaned: string[] = [];
    for (const file of rootConfigsPresent) {
      const [, pkg, filename] = file.split("/");
      if (!(pkg && filename)) continue;
      const text = packageTsconfigs[pkg];
      // A package with a root config and no tsconfig at all is the same defect.
      if (text === undefined) {
        orphaned.push(`${file} (packages/${pkg} has no tsconfig.json)`);
        continue;
      }
      if (!includeEntries(text).some((entry) => reachesPackageRoot(entry, filename))) {
        orphaned.push(file);
      }
    }
    expect(
      orphaned,
      "root config file in no tsc program — add `*.ts` to the package's include",
    ).toEqual([]);
  });

  test("the three root programs claim the file types no package tsconfig can", () => {
    // Files outside `packages/` belong to no package program, so the root
    // configs are the only thing that can see them — and each one's `include`
    // is the whole statement of what it covers. The seams between these three
    // are where a root `.mjs` and a `scripts/**/*.ts` were lost.
    const globs = Object.fromEntries(
      Object.entries(
        import.meta.glob("../../../tsconfig.*.json", {
          query: "?raw",
          import: "default",
          eager: true,
        }),
      ).map(([key, text]) => [repoPathOf(key), includeEntries(text as string)]),
    );

    // Root-level TypeScript (vitest.config.ts, vitest.slow.config.ts, …).
    expect(globs["tsconfig.tools.json"]).toContain("*.ts");
    // TypeScript under scripts/ — the load-test agent sources. Full strictness
    // is the point of it landing in `tools` rather than in `scripts`.
    expect(globs["tsconfig.tools.json"]).toContain("scripts/**/*.ts");
    // Root-level JavaScript (the Stryker configs), plus the two trees.
    expect(globs["tsconfig.scripts.json"]).toContain("*.mjs");
    expect(globs["tsconfig.scripts.json"]).toContain("scripts/**/*.mjs");
    expect(globs["tsconfig.scripts.json"]).toContain("examples/**/*.mjs");
    // Browser JavaScript, which needs `lib: DOM` and so cannot live in either
    // of the two Node programs above.
    expect(globs["tsconfig.browser.json"]).toContain("examples/**/public/**/*.js");
  });

  test("the browser program admits DOM and refuses node", () => {
    // The two halves that make it a separate program rather than a widening of
    // either Node config. Losing `checkJs` is the silent one: `allowJs` alone
    // parses these files and checks nothing, so the gate would keep passing
    // over 2,200 lines it no longer reads.
    const text = (sole(
      import.meta.glob("../../../tsconfig.browser.json", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    ) ?? "") as string;
    expect(text.length).toBeGreaterThan(500);
    expect(text).toMatch(/"lib"\s*:\s*\[[^\]]*"DOM"/);
    expect(text).toMatch(/"checkJs"\s*:\s*true/);
    expect(text).toMatch(/"allowJs"\s*:\s*true/);
    // `types: []`, not `["node"]` — these run in a page.
    expect(text).toMatch(/"types"\s*:\s*\[\s*\]/);
  });

  test("the scaffold's shipped configs are checked by check:template-types", () => {
    // `packages/aai-templates/tsconfig.json` deliberately stops at `src`, so
    // the scaffold tree is checked by that gate instead — under the compiler a
    // user actually gets. Which means the gate's `include` list is the only
    // thing standing between a shipped config and no compiler at all, and it
    // named `global.d.ts` and `server.mjs` only.
    const gate = (sole(
      import.meta.glob("../../../scripts/check-template-types.mjs", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    ) ?? "") as string;
    expect(gate.length).toBeGreaterThan(1000);
    for (const name of ["global.d.ts", "server.mjs", "vite.config.ts", "vitest.config.ts"]) {
      expect(gate, `check-template-types.mjs does not check scaffold/${name}`).toContain(
        `"${name}"`,
      );
    }
  });
});
