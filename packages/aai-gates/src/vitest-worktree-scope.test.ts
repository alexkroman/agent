// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * A path handed to `vitest run` is a FILTER, not a location — so a run at the
 * repo root can collect a stale copy of the suite out of a git worktree.
 *
 * `.worktrees/` is where this repo checks its worktrees out (`.gitignore`), and
 * there are routinely ~20 of them holding ~100 copies of every scenario file.
 * They are the same suites with the same hard-coded slugs, so a filtered
 * scenario run collects both copies and races them against one database — and
 * the failure names a table or a slug rather than a checkout, which is why it
 * reads as a bug in the code under test. It has cost two separate sessions a
 * completely phantom diagnosis, one of them ending at
 * `relation "aai_workflow_uploads" does not exist` from a branch six weeks old.
 *
 * ## Only ONE config can reach them, and the exclude belongs there
 *
 * The obvious home is `vitest.shared.ts`, and it is the wrong one twice over.
 * Nine of the ten package configs declare their own `exclude`, which REPLACES a
 * shared one rather than extending it (the trap AGENTS.md records for `test` and
 * `setupFiles`), so it would be dead config in almost every package. And it
 * would be dead there anyway: a package config's `root` is its own directory, so
 * `.worktrees/` is not under it — measured, `vitest list <filter>` at the repo
 * root collects only the real file.
 *
 * `vitest.slow.config.ts` is the exception, and the whole exposure: it is a
 * ROOT-level config whose `root` is wherever it is invoked from, so a run from
 * the repo root globs the worktrees in. Reproduced by A/B on this tree — with
 * the exclude removed, one filtered scenario pattern collected
 * `packages/aai-server/src/platform-session-state.scenario.test.ts` AND
 * `.worktrees/tts-sandbox-truncation/…/platform-session-state.scenario.test.ts`;
 * with it, only the first.
 *
 * So this spec pins the exclude where it is load-bearing, and pins the two
 * properties that keep the other configs out of reach — because "the exclude is
 * unnecessary here" is a claim that silently stops being true.
 */

import { describe, expect, test } from "vitest";
import { repoPathOf, sole } from "./_gate-support.ts";

const slow = sole(
  import.meta.glob<string>("../../../vitest.slow.config.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const root = sole(
  import.meta.glob<string>("../../../vitest.config.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const gitignore = sole(
  import.meta.glob<string>("../../../.gitignore", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/** Every package's own vitest config, as source. */
const packageConfigs = Object.entries(
  import.meta.glob<string>("../../*/vitest.config.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).map(([key, source]) => ({ path: repoPathOf(key), source }));

/**
 * Source with every comment removed.
 *
 * Load-bearing rather than tidy: these configs carry long paragraphs ABOUT their
 * own excludes, so any assertion over the raw text is satisfied by the
 * explanation of the rule instead of the rule. Measured — `toContain
 * (".worktrees")` over the raw source passed with the exclude deleted.
 */
const withoutComments = (source: string | undefined): string =>
  (source ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The `test.exclude` array literal, comments already gone. */
const excludeArray = (source: string | undefined): string =>
  /exclude:\s*\[([^\]]*)\]/.exec(withoutComments(source))?.[1] ?? "";

describe("no vitest run can collect a worktree copy", () => {
  test("the configs were discovered", () => {
    // The floor every gate in this package carries: each assertion below reads a
    // source string, so a glob that stopped resolving would check an `undefined`
    // and pass. Nine packages today.
    expect(slow, "vitest.slow.config.ts not readable").toBeTypeOf("string");
    expect(root, "vitest.config.ts not readable").toBeTypeOf("string");
    expect(gitignore, ".gitignore not readable").toBeTypeOf("string");
    expect(packageConfigs.length, "no package vitest configs found").toBeGreaterThanOrEqual(8);
  });

  test("the worktree directory is still called .worktrees", () => {
    // The glob below is a literal, so it is only correct while this is where
    // worktrees land. Moving them without moving the exclude re-opens the hole
    // with every config still looking right.
    expect(gitignore, ".worktrees is not the ignored worktree directory").toContain(".worktrees/");
  });

  test("vitest.slow.config.ts excludes the worktrees IN CODE", () => {
    // Asserted against the exclude array with the comments stripped, and the
    // first draft of this line was `toContain(".worktrees")` over the raw source
    // — which passed with the exclude DELETED, because the paragraph explaining
    // it survived. A gate satisfied by prose about the thing it checks is the
    // exact failure this directory exists to catch, found by the A/B that was
    // supposed to be a formality.
    expect(excludeArray(slow), "the slow tiers can collect a stale worktree copy").toContain(
      ".worktrees",
    );
  });

  test("it EXTENDS vitest's default excludes rather than replacing them", () => {
    // Declaring `exclude` replaces the defaults, and the default that matters is
    // `node_modules` — losing it would collect every dependency's own tests,
    // which is a far louder failure than the one being fixed but arrives by the
    // same one-line edit.
    expect(excludeArray(slow), "exclude does not spread configDefaults.exclude").toContain(
      "...configDefaults.exclude",
    );
    expect(withoutComments(slow), "configDefaults is not imported").toMatch(
      /import\s*\{[^}]*\bconfigDefaults\b[^}]*\}\s*from\s*"vitest\/config"/,
    );
  });

  test("the root config collects ONLY through package-scoped projects", () => {
    // This is why the unit tier needs no exclude of its own: every collection
    // goes through a project whose root is a package directory, and `.worktrees/`
    // is under none of them. A top-level `include` here would put the root's own
    // glob back over the whole tree and reopen the footgun for `pnpm vitest run
    // <path>`, the most common spelling of all.
    expect(root).toMatch(/projects:\s*\[/);
    expect(root, "the root config declares a top-level test.include").not.toMatch(/\n {4}include:/);
  });

  test.each(packageConfigs)("$path is scoped to its own package", ({ source }) => {
    // The other half of the same claim. A package config with an explicit `root`
    // pointing outside its directory — or one that stopped spreading the shared
    // options and so lost the rest of this file's assumptions — would need its
    // own exclude. Neither is true today, and this is what says so.
    expect(source, "does not spread ...sharedConfig.test").toContain("...sharedConfig.test");
    expect(source, "declares a root outside its own package").not.toMatch(/root:\s*"\.\.\//);
  });
});
