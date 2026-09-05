// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * A package's own suite and its coverage floors must be REACHABLE.
 *
 * Every fan-out door in this repo is `turbo run <task>`, and turbo SILENTLY
 * SKIPS a package that does not declare the task. So a missing script is not an
 * error anywhere: the package simply stops being checked, with the same green
 * output as a package that passed. It has happened twice, in both directions —
 * `aai-templates` declared no `lint`, so `turbo run lint` (and therefore
 * `pnpm check`) skipped it entirely; and `aai-evals`, then `aai-runtime`, were
 * absent from CI's coverage matrix while `scripts/check.mjs` ran
 * `turbo run test:coverage` unfiltered, so their suites and their floors were
 * gated by nothing in CI while passing locally.
 *
 * `ci-gate-job.test.ts` closed one DIRECTION of that: every package declaring
 * `test:coverage` is named in the matrix. The other direction is the one still
 * open, and it is the one the two live bugs took — a package that declares no
 * `test:coverage` legitimately drops out of that comparison, so deleting the
 * script silences the package and passes both gates. Hence the assertion here
 * is on the SET of packages: all ten declare all three scripts, and each
 * declares its own coverage floors.
 *
 * Read as SOURCE, like every gate spec in this package: this tsconfig pulls in
 * no node types, and importing ten vitest configs would evaluate
 * `defineConfig` and answer what is resolved today rather than what is
 * declared.
 *
 * The floors on the discovered counts are not ceremony — the whole suite is a
 * per-package loop, so a glob that stopped matching would assert nothing and
 * print the healthiest possible result.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, repoPathOf } from "./_gate-support.ts";

/**
 * The package directory a glob key names.
 *
 * Through `repoPathOf` rather than a prefix test on the key, because Vite
 * normalizes the globbing package's OWN file to a different spelling than the
 * siblings' (`./package.json` against `../../aai/package.json`) — resolving
 * both against this file's directory is what makes the self entry land in the
 * set. Getting it wrong is silent: the entry drops out, and the package this
 * spec lives in is the one that stops being checked.
 */
const dirOf = (key: string): string => repoPathOf(key).split("/")[1] ?? "";

/** Every workspace package's manifest, as source. */
const manifests = Object.entries(
  import.meta.glob<string>("../../*/package.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).map(([key, source]) => ({ dir: dirOf(key), source }));

/** Every workspace package's vitest config, as source. */
const configs = Object.entries(
  import.meta.glob<string>("../../*/vitest.config.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).map(([key, source]) => ({ dir: dirOf(key), source }));

/** The scripts a fan-out door needs a package to declare, and what skips it. */
const REQUIRED_SCRIPTS = [
  ["test", "`turbo run test` — the package's whole unit suite"],
  ["test:coverage", "`turbo run test:coverage`, both check.mjs modes, and CI's matrix"],
  ["lint", "`turbo run lint`, i.e. biome over the package"],
] as const;

/** The four metrics a coverage floor has to name to be one. */
const METRICS = ["lines", "functions", "branches", "statements"] as const;

const declares = (source: string, script: string): boolean =>
  new RegExp(`"${script}"\\s*:`).test(source);

describe("per-package test wiring", () => {
  test("both sides were discovered, and they describe the same packages", () => {
    expect(manifests.length, "no package manifests found").toBeGreaterThanOrEqual(10);
    expect(configs.length, "no package vitest configs found").toBeGreaterThanOrEqual(10);
    // konsistent's `workspace-package-layout` requires both files per package;
    // this is the same claim from the side that then reads them, so a package
    // present in one list and absent from the other fails HERE rather than
    // dropping out of the loops below.
    expect(configs.map((config) => config.dir).sort(byCodeUnit)).toEqual(
      manifests.map((manifest) => manifest.dir).sort(byCodeUnit),
    );
  });

  test.each(manifests)("$dir declares every fan-out script", ({ source }) => {
    for (const [script, door] of REQUIRED_SCRIPTS) {
      expect(
        declares(source, script),
        `declares no "${script}" script, so ${door} SKIPS this package — silently, ` +
          "with the same output as a package that passed",
      ).toBe(true);
    }
  });

  test.each(configs)("$dir declares its own coverage floors", ({ source }) => {
    // Package-wide floors are the only ones anything evaluates: the root
    // `vitest.config.ts` deliberately holds none (nothing in the repo or in CI
    // ever read them), so a package with no `thresholds` has a `test:coverage`
    // script that MEASURES coverage and then throws the number away.
    const found = /thresholds:\s*\{([^}]*)\}/.exec(source);
    expect(found, "declares no coverage `thresholds`, so its floors are unenforced").not.toBeNull();
    const body = found?.[1] ?? "";
    for (const metric of METRICS) {
      expect(body, `the coverage thresholds name no \`${metric}\` floor`).toMatch(
        new RegExp(`${metric}:\\s*\\d`),
      );
    }
  });
});
