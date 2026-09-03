// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Guards `scripts/check-package-layout.mjs` — the gate that keeps a package's
 * TypeScript under `src/`.
 *
 * The gate's whole output on a healthy tree is a COUNT, which is the failure
 * shape this repo keeps paying for: a scan that stops resolving prints the same
 * checkmark as a tree that is correct. So the assertions here are about the
 * things that would let it pass while measuring nothing —
 *
 * - both FLOORS are present and are under the tree's real size (a floor above
 *   it fails every run; a floor of zero is no floor at all),
 * - the rule is stated from BOTH sides, because "no `.ts` outside `src/`" is
 *   vacuously true of an emptied package,
 * - the exemptions are the two narrow ones, spelled per package and per
 *   directory rather than as a glob that a future directory could inherit,
 * - and it is wired into `scripts/check.mjs`, since a gate reachable only by
 *   `pnpm check:package-layout` is enforced by nobody.
 *
 * Assertions are made against the script's SOURCE, as in
 * `file-length-gate.test.ts` and `test-assertion-gate.test.ts`: this package's
 * tsconfig declares no node types, so a spec here cannot spawn the gate or
 * import its node-builtin-using module — it reads the file that CI runs.
 */

import { describe, expect, test } from "vitest";
import { GATE_WIRING, numericConstant, repoPathOf, sole } from "./_gate-support.ts";

const script = sole(
  import.meta.glob("../../../scripts/check-package-layout.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/** The same text, never absent — every reader below scrapes it. */
const source: string = script ?? "";

/**
 * Every TypeScript file the gate could select, repo-relative.
 *
 * Only the KEYS are read, so these are lazy imports nothing ever calls — the
 * pattern `guard-invariants-gate.test.ts` and `file-length-gate.test.ts` both
 * use. Two globs because a git pathspec's trap has a Vite counterpart: `**\/`
 * carries a literal slash, so the shallow level needs its own pattern.
 *
 * `dist/` is dropped because the gate's corpus is `git ls-files` and Vite's is
 * the filesystem: on a tree that has been built, the four publishable packages
 * contribute 821 emitted `.d.ts` files that git has never heard of. An
 * independent corpus is the point of globbing here rather than shelling out —
 * it just has to be independent about the same SET.
 */
const repoFiles = Object.keys({
  ...import.meta.glob("../../*/*.{ts,tsx}"),
  ...import.meta.glob("../../*/**/*.{ts,tsx}"),
})
  .map(repoPathOf)
  .filter((f) => !f.includes("/dist/"));

/** The package directory names those files sit in. */
const packageDirs = [...new Set(repoFiles.map((f) => f.split("/")[1]).filter(Boolean))];

describe("check:package-layout", () => {
  test("the gate source resolves", () => {
    // Everything below scrapes it; an unresolved glob would make each assertion
    // a search of the empty string, which passes for `not.toContain`.
    expect(script).toBeTypeOf("string");
    expect(source.length).toBeGreaterThan(2000);
  });

  test("it states the rule from BOTH sides", () => {
    // "No `.ts` outside `src/`" is true of a package with no TypeScript at all,
    // so the gate has to also require that `src/` HOLDS something. Losing the
    // second half is invisible: the first keeps printing its checkmark.
    expect(source).toContain('parts[2] !== "src"');
    // The CONDITION, not just the name: A/B'd by neutering this branch to
    // `if (false)`, which left every other assertion here passing — the
    // vacuous-guard failure this whole file exists to catch, reproduced in the
    // spec that was supposed to catch it.
    expect(source).toMatch(/if \(noSrc\.length > 0\)/);
    expect(source).toMatch(/if \(stray\.length > 0\)/);
    expect(source).toContain("package(s) with no");
  });

  test("both corpus floors are real numbers, under the tree they measure", () => {
    // A floor ABOVE the tree fails every run and gets deleted; a floor of zero
    // is the gate reporting success over a scan that found nothing. The
    // measured tree is the only honest calibration.
    const where = "scripts/check-package-layout.mjs";
    const minPackages = numericConstant(source, "MIN_PACKAGES", where);
    const minFiles = numericConstant(source, "MIN_FILES", where);
    expect(minPackages).toBeGreaterThan(0);
    expect(minFiles).toBeGreaterThan(0);
    expect(packageDirs.length).toBeGreaterThanOrEqual(minPackages);
    expect(repoFiles.length).toBeGreaterThanOrEqual(minFiles);
  });

  test("the floors are checked BEFORE the comparisons they protect", () => {
    // Order is the whole point: a floor evaluated after the violation scan
    // would report "0 violations" on an empty corpus and never reach the floor.
    expect(source.indexOf("MIN_PACKAGES")).toBeLessThan(source.indexOf("const stray"));
    expect(source.indexOf("MIN_FILES")).toBeLessThan(source.indexOf("const stray"));
  });

  test("the root-config exemption is a NAME list, not a pattern", () => {
    // These are resolved by name from the package directory by tools that are
    // not ours. A pattern (`*.config.ts`) would quietly exempt anything a
    // future author named that way.
    for (const name of ["vitest.config.ts", "vite.config.ts", "tsdown.config.ts"]) {
      expect(source).toContain(`"${name}"`);
    }
    expect(source).toContain("ROOT_CONFIGS = new Set");
  });

  test("the product-tree exemption is per package AND per directory", () => {
    // A repo-wide `**\/templates/**` would exempt any future directory taking
    // the name. Keyed by package, the exemption is a reviewable line.
    expect(source).toContain("PRODUCT_TREES");
    expect(source).toMatch(/"aai-templates":\s*\["templates",\s*"scaffold"\]/);
    expect(source).not.toMatch(/\*\*\/templates/);
  });

  test("the exempted product trees really exist", () => {
    // An exemption for a directory that is gone is an exemption that will be
    // inherited by whatever next takes the path — and it reads as deliberate.
    for (const dir of ["templates", "scaffold"]) {
      expect(
        repoFiles.some((f) => f.startsWith(`packages/aai-templates/${dir}/`)),
        `packages/aai-templates/${dir} is exempt but holds no TypeScript`,
      ).toBe(true);
    }
  });

  test("the tree it guards actually satisfies it", () => {
    // The gate's own verdict, re-derived here from an independent corpus (Vite
    // globs rather than `git ls-files`) so the two agree only when the tree
    // really is what both believe.
    const outside = repoFiles.filter((f) => {
      const parts = f.split("/");
      if (parts[2] === "src") return false;
      if (
        parts.length === 3 &&
        ["vitest.config.ts", "vite.config.ts", "tsdown.config.ts"].includes(parts[2] ?? "")
      ) {
        return false;
      }
      return !(parts[1] === "aai-templates" && ["templates", "scaffold"].includes(parts[2] ?? ""));
    });
    expect(outside).toEqual([]);
  });

  test("every package has a non-empty src/", () => {
    const without = packageDirs.filter(
      (pkg) => !repoFiles.some((f) => f.startsWith(`packages/${pkg}/src/`)),
    );
    expect(without).toEqual([]);
  });

  test("it is wired into the gate runner, not only into package.json", () => {
    // A gate reachable only by its own npm script is enforced by whoever
    // remembers to type it. `check.mjs` is what `pnpm check` and CI both run —
    // CI derives its list from that table rather than restating it.
    const manifest = GATE_WIRING["package.json"] ?? "";
    const runner = GATE_WIRING["scripts/check.mjs"] ?? "";
    expect(manifest).toContain('"check:package-layout"');
    expect(manifest).toContain("scripts/check-package-layout.mjs");
    expect(runner).toContain('script: "check:package-layout"');
    expect(runner).toMatch(/check:package-layout[^\n]*phase: "ratchets"/);
  });
});
