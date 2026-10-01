// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `sharedSetupFiles` reaches EVERY vitest project.
 *
 * `setupFiles` is an ARRAY, so a config writing its own list after
 * `...sharedConfig.test` REPLACES the shared one silently and the
 * listener-leak gate (`scripts/fail-on-process-warning.mjs`) stops applying.
 * Package configs go through `defineUnitProject`, which appends; the slow
 * config spreads the list by hand. Asserted against config SOURCE, because a
 * loaded config shows what is right today rather than the spread that keeps it
 * right.
 */

import { describe, expect, test } from "vitest";
import { repoPathOf, sole } from "./_gate-support.ts";

/** Every package's own vitest config, as source. */
const packageConfigs = Object.entries(
  import.meta.glob<string>("../../*/vitest.config.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).map(([key, source]) => ({ path: repoPathOf(key), source }));

/** The two repo-root configs that also declare `setupFiles`. */
const rootConfigs = Object.entries(
  import.meta.glob<string>("../../../vitest*.config.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).map(([key, source]) => ({ path: repoPathOf(key), source }));

const shared = sole(
  import.meta.glob<string>("../../../vitest.shared.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const turbo = sole(
  import.meta.glob<string>("../../../turbo.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/** `setupFiles:` declared anywhere in a config's source. */
const declaresSetupFiles = (source: string): boolean => /setupFiles:/.test(source);

/** …and the declaration carries the shared list forward. */
const spreadsSharedSetupFiles = (source: string): boolean =>
  /setupFiles:\s*\[\s*\.\.\.sharedSetupFiles/.test(source);

describe("shared vitest setupFiles wiring", () => {
  test("the package configs were discovered", () => {
    // A floor, for the reason every gate in this package carries one: the whole
    // suite below is a per-config loop, so a glob that stopped matching would
    // assert nothing at all and pass.
    expect(packageConfigs.length, "no package vitest configs found").toBeGreaterThanOrEqual(8);
    expect(rootConfigs.length, "no root vitest configs found").toBeGreaterThanOrEqual(2);
    expect(shared, "vitest.shared.ts not readable").toBeTypeOf("string");
  });

  test("vitest.shared.ts exports sharedSetupFiles and uses it", () => {
    expect(shared).toContain("export const sharedSetupFiles");
    // The shared config must itself hand the list to `setupFiles`, else a
    // config that declares none inherits an empty array.
    expect(shared, "sharedConfig.test does not set setupFiles").toMatch(
      /setupFiles:\s*sharedSetupFiles/,
    );
    expect(shared, "the gate script is not named").toContain("fail-on-process-warning.mjs");
  });

  test("defineUnitProject APPENDS to the shared setup files and env", () => {
    // The factory is where the merge semantics live, so a factory that
    // assigned `options.setupFiles` would drop the gate from every package.
    expect(shared).toContain("export function defineUnitProject");
    expect(shared, "the factory replaces setupFiles instead of appending").toMatch(
      /setupFiles:\s*\[\s*\.\.\.sharedSetupFiles,\s*\.\.\.\(options\.setupFiles/,
    );
    expect(shared, "the factory replaces env instead of merging").toMatch(
      /env:\s*\{\s*\.\.\.sharedConfig\.test\.env,\s*\.\.\.options\.env/,
    );
  });

  test.each(packageConfigs)("$path goes through defineUnitProject", ({ source }) => {
    // The one legal shape: the factory owns the shared options, the tier
    // excludes and the merges. A hand-written `defineConfig` re-opens the
    // replace-instead-of-extend trap the factory exists to close.
    expect(source, "does not call defineUnitProject").toContain("defineUnitProject({");
    expect(source, "re-declares the shared test options by hand").not.toContain(
      "...sharedConfig.test",
    );
    expect(
      spreadsSharedSetupFiles(source),
      "spreads sharedSetupFiles itself, so the gate would load twice",
    ).toBe(false);
  });

  test.each(rootConfigs)("$path carries the shared setup files", ({ source }) => {
    if (!declaresSetupFiles(source)) return;
    expect(
      spreadsSharedSetupFiles(source),
      "a root config declares setupFiles without spreading sharedSetupFiles",
    ).toBe(true);
  });

  test("the slow tiers cannot select the gate away", () => {
    const slow = rootConfigs.find(({ path }) => path === "vitest.slow.config.ts");
    expect(slow, "vitest.slow.config.ts not found").toBeTypeOf("object");
    // `VITEST_SETUP` chooses a package's own setup file per run. Assigned rather
    // than appended it would drop the gate from every slow tier — the suites
    // that open real sockets and run thousands of fast-check iterations against
    // one long-lived signal, i.e. where a listener leak actually lives.
    expect(slow?.source).toMatch(/setupFiles:\s*\[\s*\.\.\.sharedSetupFiles/);
    expect(slow?.source).toContain("VITEST_SETUP");
  });

  test("the gate's opt-out has exactly one user", () => {
    // `globalThis[Symbol.for("aai.expectsProcessWarnings")]` suppresses the
    // listener-leak gate for a suite whose SUBJECT is the warning. There is one
    // such suite — the guest's leak-watch spec, which synthesizes the warnings
    // it drives its watcher with. An opt-out nobody counts is how a gate dies
    // quietly: each new user makes the gate narrower with no diff saying so.
    const users = Object.entries(
      import.meta.glob<string>("../../*/**/*.test.ts", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    )
      .filter(([, source]) => source.includes("aai.expectsProcessWarnings"))
      .map(([key]) => repoPathOf(key));
    expect(users, "the opt-out spread beyond the guest's leak-watch spec").toEqual([
      "packages/aai-guest/src/harness/leak-watch.test.ts",
    ]);
  });

  test("turbo hashes the gate script", () => {
    // `inputs` globs resolve relative to the PACKAGE, so a repo-root file every
    // test task loads is hashed by no package's inputs — and this file decides
    // whether a suite FAILS on a leak, so an unhashed change replays a cached
    // green run. The root guide documents four prior instances of exactly this.
    expect(turbo, "turbo.json not readable").toBeTypeOf("string");
    expect(turbo, "scripts/fail-on-process-warning.mjs is not in globalDependencies").toContain(
      '"scripts/fail-on-process-warning.mjs"',
    );
  });
});
