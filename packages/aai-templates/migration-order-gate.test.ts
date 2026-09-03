// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `scripts/check-migration-order.mjs` — the gate that a migration this branch
 * adds sorts after every migration already on the base.
 *
 * The gate exists because `supabase db push` refuses the WHOLE push when a
 * pending file sorts at or before the last row in the remote history table, and
 * the production deploy declares `needs: migrate`. Two branches open at once
 * each added a correct migration and merged into a pair that blocked every
 * release (#1360, 37 minutes after #1358).
 *
 * Which makes this the usual shape for this directory: the gate's whole success
 * output is a COUNT, so a prefix or a filename pattern that stopped matching
 * prints the same checkmark as a healthy branch — and there is a live corpus of
 * exactly one repository to notice it in. So the decisions are asserted against
 * inputs the tree does not currently contain, and the real migration directory
 * is asserted to still be where the gate looks.
 *
 * The decisions are VALUE-imported from `scripts/_migration-order-scope.mjs`
 * rather than scraped out of the gate's source, for the reason
 * `guard-invariants-gate.test.ts` records against its own third draft: the rules
 * moved into a module and every per-rule assertion went vacuous while still
 * printing green. That module imports nothing, which is what makes it importable
 * from a package whose tsconfig has no node types.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, GATE_WIRING, numericConstant, sole } from "./_gate-support.ts";

const script = sole(
  import.meta.glob<string>("../../scripts/check-migration-order.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/** The gate's real decisions, imported rather than re-derived. */
const scope = sole(
  import.meta.glob<{
    MIGRATIONS_PREFIX: string;
    VERSION_DIGITS: number;
    isMigrationPath: (path: string) => boolean;
    migrationVersion: (path: string) => string | null;
    malformedNames: (paths: readonly string[]) => string[];
    duplicateVersions: (paths: readonly string[]) => { version: string; files: string[] }[];
    highestVersion: (paths: readonly string[]) => string | null;
    refusedAdditions: (args: {
      added: readonly string[];
      baseHighest: string | null;
    }) => { file: string; version: string }[];
    nextFreeVersion: (baseHighest: string) => string;
  }>("../../scripts/_migration-order-scope.mjs", { eager: true }),
);

/**
 * Every migration in the repository, by filename.
 *
 * Only the KEYS are read, so these are lazy imports nothing ever calls — the
 * trick the sibling specs use to enumerate the tree without loading it.
 */
const migrationPaths = Object.keys(import.meta.glob("../../supabase/migrations/*.sql")).map((key) =>
  key.replace("../../", ""),
);

/** The floor under the corpus, from the gate rather than restated. */
const MIN_MIGRATIONS = numericConstant(
  script ?? "",
  "MIN_MIGRATIONS",
  "scripts/check-migration-order.mjs",
);

describe("the gate is wired where it is enforced", () => {
  test("both runner files name it", () => {
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} does not name check:migration-order`).toContain(
        "check:migration-order",
      );
    }
  });

  test("it sits in the ratchets phase, so the required CI job runs it", () => {
    // `check.yml` runs `node scripts/check.mjs --gates ci`, and GATE_SELECTIONS
    // maps `ci` to ["ratchets", "after-build"]. A gate in neither phase is
    // enforced by the pre-push hook alone, which `git push --no-verify` skips.
    const row = /\{\s*script:\s*"check:migration-order",\s*phase:\s*"(\w+)"/.exec(
      GATE_WIRING["scripts/check.mjs"] ?? "",
    );
    expect(row?.[1]).toBe("ratchets");
  });
});

describe("the corpus the gate measures is really there", () => {
  test("the directory the gate looks in is where the migrations are", () => {
    // The gate's whole scope is one string. A prefix that no longer matches
    // enumerates nothing and prints a checkmark over every migration.
    expect(scope?.MIGRATIONS_PREFIX).toBe("supabase/migrations/");
    for (const path of migrationPaths) {
      expect(scope?.isMigrationPath(path), `${path} is outside the gate's scope`).toBe(true);
    }
  });

  test("the real tree clears the gate's own floor", () => {
    expect(MIN_MIGRATIONS).toBeGreaterThan(0);
    expect(migrationPaths.length).toBeGreaterThanOrEqual(MIN_MIGRATIONS);
  });

  test("every committed migration parses, at one fixed width", () => {
    // The gate compares versions as STRINGS, which is only a numeric comparison
    // while every version is the same width. This is that premise, asserted.
    for (const path of migrationPaths) {
      const version = scope?.migrationVersion(path);
      expect(version, `${path} is not <14 digits>_<name>.sql`).not.toBeNull();
      expect(version).toHaveLength(scope?.VERSION_DIGITS ?? 14);
    }
    expect(scope?.malformedNames(migrationPaths)).toEqual([]);
    expect(scope?.duplicateVersions(migrationPaths)).toEqual([]);
  });
});

describe("the order rule", () => {
  const base = "20260902120000";

  test("#1360 is refused — the pair that actually blocked production", () => {
    // The real filenames and the real blocker, so this case cannot pass by the
    // rule quietly narrowing to something the repo no longer contains.
    const refused = scope?.refusedAdditions({
      added: [
        "supabase/migrations/20260902000000_workflow_step_started_at.sql",
        "supabase/migrations/20260902010000_workflow_run_code_version.sql",
      ],
      baseHighest: base,
    });
    expect(refused?.map((entry) => entry.version)).toEqual(["20260902000000", "20260902010000"]);
  });

  test("the remedy that shipped is accepted", () => {
    expect(
      scope?.refusedAdditions({
        added: [
          "supabase/migrations/20260902130000_workflow_step_started_at.sql",
          "supabase/migrations/20260902140000_workflow_run_code_version.sql",
        ],
        baseHighest: base,
      }),
    ).toEqual([]);
  });

  test("a TIE is refused, not just an earlier version", () => {
    // Equal versions collide in the history table, so the boundary is `<=`.
    // An off-by-one to `<` here would pass a file that can never be applied.
    expect(
      scope?.refusedAdditions({
        added: [`supabase/migrations/${base}_same_stamp.sql`],
        baseHighest: base,
      }),
    ).toHaveLength(1);
  });

  test("a base with no migrations refuses nothing", () => {
    expect(
      scope?.refusedAdditions({
        added: ["supabase/migrations/20200101000000_first.sql"],
        baseHighest: null,
      }),
    ).toEqual([]);
    expect(scope?.highestVersion([])).toBeNull();
  });

  test("highestVersion ignores anything outside the scope", () => {
    expect(
      scope?.highestVersion([
        "supabase/migrations/20260101000000_a.sql",
        "supabase/migrations/README.md",
        "supabase/config.toml",
        "packages/aai-server/99999999999999_not_a_migration.sql",
      ]),
    ).toBe("20260101000000");
  });

  test("the suggested version really clears the blocker", () => {
    const suggestion = scope?.nextFreeVersion(base) ?? "";
    expect(suggestion).toHaveLength(scope?.VERSION_DIGITS ?? 14);
    expect(byCodeUnit(suggestion, base)).toBeGreaterThan(0);
    // It is the rename that actually shipped, which is the useful evidence that
    // the hint is a working command rather than a plausible-looking string.
    expect(suggestion).toBe("20260902130000");
  });
});

describe("the rules that need no diff still bite", () => {
  test("a malformed name is reported rather than skipped", () => {
    // A stamp of the wrong width sorts somewhere nobody predicted, so skipping
    // it is the one thing the gate must not do.
    const paths = [
      "supabase/migrations/2026090212000_short.sql", // 13 digits
      "supabase/migrations/202609021200000_long.sql", // 15
      "supabase/migrations/no_version_at_all.sql",
      "supabase/migrations/20260902120000_fine.sql",
    ];
    expect(scope?.malformedNames(paths)).toEqual([
      "supabase/migrations/202609021200000_long.sql",
      "supabase/migrations/2026090212000_short.sql",
      "supabase/migrations/no_version_at_all.sql",
    ]);
  });

  test("two files claiming one version are reported together", () => {
    const dupes = scope?.duplicateVersions([
      "supabase/migrations/20260902120000_one.sql",
      "supabase/migrations/20260902120000_two.sql",
      "supabase/migrations/20260902130000_alone.sql",
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes?.[0]?.version).toBe("20260902120000");
    expect(dupes?.[0]?.files).toHaveLength(2);
  });
});

describe("the diff-scoped half keeps its two hard-won flags", () => {
  test("renames are turned off, so a backwards rename is still an addition", () => {
    // Git reports a rename as one `R` entry. The fix for #1360 IS a rename, so
    // the edit that re-creates it is one too — with renames on, the gate would
    // not see the new name at all.
    expect(script).toContain("--no-renames");
    expect(script).toContain("--diff-filter=A");
  });

  test("an unresolvable base FAILS rather than skipping", () => {
    // The half of the no-git-ref rule that still applies to a diff-scoped gate:
    // a checkmark over a comparison that never happened is this repo's
    // signature failure.
    expect(script).toContain("assertBaseResolves");
    expect(script).toMatch(/cannot resolve[\s\S]{0,400}process\.exit\(1\)/);
  });

  test("it explains why a --dry-run in CI cannot replace it", () => {
    // The design's load-bearing claim, measured: `supabase start` applies every
    // migration on init, so a dry-run there has no later row to collide with.
    // If this note goes, the next author adds the job that cannot work.
    expect(script).toContain("dry-run");
    expect(script).toContain("supabase start");
  });
});
