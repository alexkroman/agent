// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Guards `scripts/sync-workflow-schema.mjs` — the CREATOR for the DevKit's
 * `workflow` schema, and the gate that keeps the vendored copy level with
 * `@workflow/world-postgres`.
 *
 * ## Why this schema needs a guard at all
 *
 * The platform's durable-run journal lives in a schema this repository does not
 * declare. Three migrations say it is "created by `@workflow/world-postgres`'s
 * own migration", and after the world moved onto the platform's database nothing
 * ran that migration: the only thing that ever had was the GUEST, against its
 * own `DATABASE_URL`. On a database nobody bootstrapped by hand every durable
 * run died on the way in with `relation "workflow.workflow_runs" does not
 * exist`, and the caller saw `{"error":"Internal server error"}`.
 *
 * ## Why the gate needs a guard
 *
 * The same reason `api-contracts-gate.test.ts` and `file-length-gate.test.ts`
 * exist: this gate's whole success output is a COUNT. A journal read that
 * stopped finding entries would compare an empty set against an empty set and
 * print "all 0 migration(s) are vendored ✓" — the healthiest-looking possible
 * run over a schema nobody creates. So this suite reads the DevKit's journal
 * independently of the script and asserts the committed migration covers it.
 *
 * Assertions are made against SOURCE text, the way the other gate specs here
 * are: this package's tsconfig has no node types, so a spec cannot spawn the
 * gate — it reads the files CI runs.
 */

import { describe, expect, test } from "vitest";
import { GATE_WIRING, numericConstant, repoPathOf, sole } from "./_gate-support.ts";

/** The path, spelled once for `repoPathOf`; the glob below needs its own literal. */
const SCRIPT = "../../scripts/sync-workflow-schema.mjs";

const script = sole(
  import.meta.glob<string>("../../scripts/sync-workflow-schema.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);
const source: string = script ?? "";

/**
 * The DevKit's own journal, read independently of the script that vendors it.
 *
 * Through `aai-server`'s `node_modules` because that is the package which
 * DECLARES the dependency — pnpm's strict layout puts no `@workflow` scope at the
 * repo root, so the obvious path resolves to nothing and every assertion below
 * would pass over an empty read. Which is the failure this whole file is about,
 * hence the explicit "is readable" case.
 */
const journal = sole(
  import.meta.glob<string>(
    "../aai-server/node_modules/@workflow/world-postgres/src/drizzle/migrations/meta/_journal.json",
    { query: "?raw", import: "default", eager: true },
  ),
);

/** Every committed migration, so coverage is read from the tree rather than claimed. */
const migrations = import.meta.glob<string>("../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The tags every committed migration declares it covers. */
function coveredTags(): string[] {
  const tags: string[] = [];
  for (const text of Object.values(migrations)) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("-- devkit-entry:")) continue;
      const tag = line.slice("-- devkit-entry:".length).trim().split(/\s+/)[0];
      if (tag !== undefined) tags.push(tag);
    }
  }
  return tags;
}

describe("the script is readable and floored", () => {
  test("resolves, so every reader below is checking something", () => {
    expect(script).toBeTypeOf("string");
    expect(source.length).toBeGreaterThan(2000);
  });

  test("carries a journal floor, because its success output is a count", () => {
    // Without it a reader that stopped finding entries prints "all 0 … ✓".
    expect(numericConstant(source, "MIN_JOURNAL_ENTRIES", repoPathOf(SCRIPT))).toBeGreaterThan(0);
  });

  test("reads the migrations folder off the package's own exports map", () => {
    // Their CLI hard-codes `dist/../src/drizzle/migrations`; the exports key is a
    // published contract, so a reorganised package fails by name instead of
    // resolving to nothing.
    expect(source).toContain('"./migrations/*.sql"');
  });

  test("names the bookkeeping drizzle itself uses, so the two are interchangeable", () => {
    // `setupDatabase` passes exactly these; a mismatch would let both apply the
    // same migration twice.
    expect(source).toContain("workflow_drizzle");
    expect(source).toContain("workflow_migrations");
  });
});

describe("the vendored migration covers the installed package", () => {
  test("the DevKit's journal is readable from here", () => {
    expect(journal).toBeTypeOf("string");
  });

  test("every journal entry is covered by a committed migration", () => {
    const entries = (JSON.parse(journal ?? "{}") as { entries?: { tag?: string }[] }).entries ?? [];
    // The floor again, on THIS side of the comparison: an empty journal would
    // otherwise satisfy the assertion below by having nothing to satisfy it with.
    expect(entries.length).toBeGreaterThanOrEqual(10);
    const covered = new Set(coveredTags());
    expect(entries.map((e) => e.tag).filter((tag) => !covered.has(tag as string))).toEqual([]);
  });

  test("the covering migration creates the six tables the platform reads", () => {
    // Named rather than counted: these are the tables `workflow-storage-world.ts`
    // serves and `20260828010000_workflow_schema_rls.sql` secures, so a vendored
    // copy that stopped creating one is a run that stalls with the schema present.
    const all = Object.values(migrations).join("\n");
    for (const table of [
      "workflow_runs",
      "workflow_steps",
      "workflow_events",
      "workflow_hooks",
      "workflow_waits",
      "workflow_stream_chunks",
    ]) {
      expect(all).toContain(table);
    }
  });

  test("it enables RLS in the same file that creates them", () => {
    // The ordering hazard `20260828010000_workflow_schema_rls.sql` names in its own
    // comment: that migration runs BEFORE the schema exists on a fresh project and
    // degrades to a no-op, so the tables land unprotected and stay that way until
    // somebody re-applies it by hand. Measured — on a fresh apply all six came up
    // with `relrowsecurity = f`.
    const vendored = Object.entries(migrations).find(([path]) =>
      path.includes("workflow_devkit_schema"),
    );
    expect(vendored).toBeDefined();
    expect(vendored?.[1]).toContain("enable row level security");
    expect(vendored?.[1]).toContain("revoke all on schema workflow");
  });
});

describe("the gate is wired where it is enforced", () => {
  test.each([
    ["package.json", "check:workflow-schema"],
    ["scripts/check.sh", "check:workflow-schema"],
    [".github/workflows/check.yml", "check:workflow-schema"],
  ])("%s runs it", (file, needle) => {
    // Both, always: the gates lived only in check.sh for a long time, which CI
    // never invokes, so `git push --no-verify` skipped every one of them.
    expect(GATE_WIRING[file]).toContain(needle);
  });
});
