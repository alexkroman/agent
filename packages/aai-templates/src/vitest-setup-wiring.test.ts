// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `sharedSetupFiles` reaches EVERY vitest project.
 *
 * The gate under `scripts/fail-on-process-warning.mjs`, and it exists because
 * that gate's failure mode is a partial rollout that looks identical to a
 * complete one. `setupFiles` is an ARRAY, so a package config writing
 *
 *     test: { ...sharedConfig.test, setupFiles: ["./_jsdom-setup.ts"] }
 *
 * REPLACES the shared list rather than extending it — no error, no warning, and
 * the suite simply stops being gated. FOUR of the nine packages declare their
 * own `setupFiles`, plus `vitest.slow.config.ts` — five chances to opt out
 * silently, and the tenth package added will be a sixth.
 *
 * This is the same trap the root guide already records for `test` itself
 * ("Shared test options live in `vitest.shared.ts` and must be SPREAD IN"),
 * where it cost every package its `reporters`. That one was found by reading;
 * this one is mechanical.
 *
 * Asserted against the config SOURCE rather than a loaded config object on
 * purpose: importing nine vitest configs would evaluate `defineConfig` and tell
 * us what the resolved array holds, which is exactly the thing that is right
 * today and silently regresses on the next edit. The spread is the invariant.
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
    // assert nothing at all and pass. Nine packages today.
    expect(packageConfigs.length, "no package vitest configs found").toBeGreaterThanOrEqual(8);
    expect(rootConfigs.length, "no root vitest configs found").toBeGreaterThanOrEqual(2);
    expect(shared, "vitest.shared.ts not readable").toBeTypeOf("string");
  });

  test("vitest.shared.ts exports sharedSetupFiles and uses it", () => {
    expect(shared).toContain("export const sharedSetupFiles");
    // The shared config must itself hand the list to `setupFiles`, else the four
    // packages that declare none inherit an empty array.
    expect(shared, "sharedConfig.test does not set setupFiles").toMatch(
      /setupFiles:\s*sharedSetupFiles/,
    );
    expect(shared, "the gate script is not named").toContain("fail-on-process-warning.mjs");
  });

  test.each(packageConfigs)("$path carries the shared setup files", ({ source }) => {
    // Two legal shapes: declare no `setupFiles` at all and inherit the shared
    // list through `...sharedConfig.test`, or declare one that spreads it. What
    // is illegal is the third — declaring one that does not.
    if (!declaresSetupFiles(source)) {
      expect(
        source,
        "declares no setupFiles, so it must spread sharedConfig.test to inherit them",
      ).toContain("...sharedConfig.test");
      return;
    }
    expect(
      spreadsSharedSetupFiles(source),
      "declares its own setupFiles WITHOUT `...sharedSetupFiles`, which replaces\n" +
        "the shared list instead of extending it — the listener-leak gate silently\n" +
        "stops applying to this package. Write:\n" +
        '  setupFiles: [...sharedSetupFiles, "./its-own-setup.ts"]',
    ).toBe(true);
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
      "packages/aai-guest/src/harness-leak-watch.test.ts",
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
