// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `scripts/check-migration-order.mjs` — the gate that a migration a branch adds
 * sorts after every migration already on the base.
 *
 * The usual shape for this directory: the gate's whole success output is a pair
 * of COUNTS, so a corpus that stopped matching prints the same checkmark as a
 * healthy branch. What is asserted here is therefore what no amount of reading
 * the script would catch — that its filename pattern really does reject the
 * digit-length mix that breaks `db push`, that it declares a floor under the
 * base corpus, and that it fails rather than skips when it cannot resolve a
 * base.
 *
 * It is the SECOND diff-scoped gate, and `AGENTS.md` records at length why no
 * other ratchet resolves a git ref: one printed "skipping ratchet" and exited 0
 * in exactly the environments that get a single commit of history. The half of
 * that rule which still applies — never report success over a comparison you
 * could not make — is asserted below, the same way its sibling asserts it.
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

/** Every migration filename, from the real directory. */
const migrations = Object.keys(
  import.meta.glob("../../supabase/migrations/*.sql", { query: "?raw" }),
).map((key) => key.slice(key.lastIndexOf("/") + 1));

/** The gate's filename pattern, read out of its source rather than restated. */
const namePattern = (): RegExp => {
  const found = /const MIGRATION_NAME = (\/.+\/);/.exec(script ?? "");
  if (!found?.[1]) throw new Error("check-migration-order.mjs no longer declares MIGRATION_NAME");
  const body = found[1].slice(1, found[1].lastIndexOf("/"));
  return new RegExp(body);
};

describe("the gate is wired where it is enforced", () => {
  test("both runner files name it", () => {
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:migration-order`).toContain(
        "check:migration-order",
      );
    }
  });

  test("it fails the process rather than only reporting", () => {
    // `check.mjs` and the CI step key on the exit status alone, so a gate that
    // printed its findings and exited 0 would be decorative.
    expect(script).toContain("process.exit(1)");
  });

  test("it declares a floor under the base corpus", () => {
    expect(script).toBeTypeOf("string");
    const floor = numericConstant(script ?? "", "MIN_BASE_MIGRATIONS", "check-migration-order.mjs");
    // Above zero, so a pathspec matching nothing fails rather than comparing
    // every addition against an empty set; below the real count, so ordinary
    // consolidation does not trip it.
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(migrations.length);
  });
});

describe("an unresolvable base is a failure, never a skip", () => {
  test("the gate never reports success over a comparison it could not make", () => {
    const source = script ?? "";
    expect(source).toBeTypeOf("string");
    const guard = source.slice(source.indexOf("function assertBaseResolves"));
    const body = guard.slice(0, guard.indexOf("\n}\n"));
    expect(body, "assertBaseResolves no longer slices out").toContain("cannot resolve");
    // The behaviour rather than the wording — the gate's own message says
    // "rather than a skip", so a /skip/i assertion would fail on the prose.
    // What can regress is the exit.
    expect(body).toContain("process.exit(1)");
    expect(body).not.toContain("process.exit(0)");
  });
});

describe("the filename pattern is the version rule", () => {
  /**
   * The digit count is not a style rule. The remote history compares
   * `supabase_migrations.schema_migrations.version` as TEXT, so an 8-digit
   * version sorts between two 14-digit ones and belongs to neither — a live
   * `db push` bug reported as "Remote migration versions not found in local
   * migrations directory", which reads as a missing FILE.
   */
  test("it accepts 14 digits and rejects every other length", () => {
    const pattern = namePattern();
    expect(pattern.test("20260903030000_workflow_run_keys.sql")).toBe(true);
    expect(pattern.test("20260903_workflow_run_keys.sql")).toBe(false);
    expect(pattern.test("2026090303000_workflow_run_keys.sql")).toBe(false);
    expect(pattern.test("202609030300000_workflow_run_keys.sql")).toBe(false);
  });

  test("it requires a descriptive tail and the .sql extension", () => {
    const pattern = namePattern();
    expect(pattern.test("20260903030000.sql")).toBe(false);
    expect(pattern.test("20260903030000_workflow_run_keys.txt")).toBe(false);
    expect(pattern.test("20260903030000_a.sql")).toBe(true);
  });

  test("every migration in the tree already satisfies it", () => {
    // The gate applies the pattern to the BASE set as well as to additions, so
    // a tree that violated it would fail every branch at once. This is the half
    // that says so in an ordinary test run.
    const pattern = namePattern();
    expect(migrations.length).toBeGreaterThan(15);
    expect(migrations.filter((name) => !pattern.test(name))).toEqual([]);
  });
});

describe("the comparison is lexicographic, like the remote history", () => {
  test("the tree's versions are unique and the newest is unambiguous", () => {
    // The gate reads `newestBase` as the max of the base set, so a duplicate
    // there would make the boundary it compares against ambiguous.
    // `platform-schema.test.ts` owns the collision assertion; this is the half
    // that says the boundary this gate depends on is well defined.
    const versions = migrations.map((name) => name.slice(0, 14));
    expect(new Set(versions).size, "two migrations share a version").toBe(versions.length);
    const sorted = [...versions].sort(byCodeUnit);
    expect(sorted.at(-1)).toBe(
      versions.reduce((max, v) => (byCodeUnit(v, max) > 0 ? v : max), versions[0] ?? ""),
    );
  });

  test("an addition EQUAL to the newest base version is rejected too", () => {
    // `<=`, not `<`. Equality is the collision case, which aborts the whole
    // `supabase start` with a duplicate-key error naming neither file — so a
    // `<` here would wave through the one inversion whose failure is worst.
    const source = script ?? "";
    expect(source).toMatch(/versionOf\(name\) <= newestBase/);
  });

  test("`--include-all` is named as the wrong answer, not the remedy", () => {
    // The flag applies every pending file whatever its order, which makes the
    // applied schema a function of MERGE order rather than filename order. A
    // future edit that reaches for it as a fix is the regression this gate
    // exists to prevent, so the reasoning has to survive in the message the
    // developer actually reads.
    const source = script ?? "";
    expect(source).toContain("--include-all");
    expect(source).toMatch(/Do NOT reach for `--include-all`/);
  });
});
