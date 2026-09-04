// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate under the journal conformance table: an ARM cannot stop existing.
 *
 * `journal-conformance.test.ts` holds the registry's own guard — every backend
 * MODULE in this package's tree is registered, every registered factory really
 * exists, an exemption says why. What it could not see is the other axis. A
 * backend's arms live in FILES, a backend may have arms in two tiers, and the
 * platform's second arm lives in `aai-server`, which this package may not
 * import. `JournalBackend.tier` could name one arm, so the second was recorded
 * in the entry's prose — and prose is not a registration.
 *
 * ## What that cost, measured before this file existed
 *
 * Moving `aai-server/journal-conformance-platform.scenario.test.ts` out of the
 * tree left `pnpm check:konsistent` clean, `node scripts/guard-invariants.mjs`
 * unchanged, and `journal-conformance.test.ts`'s own registry fully green — the
 * one arm that can see a bug in the platform's SQL, deleted, with the table
 * still reporting three conformant backends.
 *
 * One gate did go red, by accident, and it is worth writing down because it is
 * the kind of coverage that reads as protection and is not.
 * `aai-server/store-conformance-registry.test.ts` scans every package for
 * exported names ending in `Conformance` and asserts each is reached from a
 * test; `loadJournalConformance`'s only call site in the repo is that arm. So
 * the failure was `loadJournalConformance is reached from a test: expected
 * false to be true` — the wrong finding (it reads as "a case list nobody
 * wired"), about the wrong file, in the wrong package. And it is contingent:
 * a second caller of the loader, a rename off the `*Conformance` suffix, or an
 * arm that keeps the loader while dropping the `journalConformance(...)` call
 * all restore full silence.
 *
 * ## What is asserted here
 *
 * Every declared arm file EXISTS, invokes the case list, invokes its backend's
 * factory, and sits in the tier it claims. The reverse too — a file that
 * answers the case list and is registered nowhere is as silent as an arm that
 * vanished. Plus floors, because every assertion above is a loop over
 * `JOURNAL_BACKENDS` and an empty registry satisfies all of them.
 *
 * A TEXT scan, and a test rather than a `guard-invariants` rule, for the two
 * reasons `store-conformance-registry.test.ts` gives: one of the arms belongs
 * to a package this one may not import, and a set comparison over declarations
 * is not a pattern a line either matches or does not.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { JOURNAL_BACKENDS } from "./journal-conformance.ts";

const PACKAGES = path.resolve(import.meta.dirname, "../..");

/** Every `.ts` file under `packages/`, excluding build output and dot dirs. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(path.relative(PACKAGES, full));
    }
  };
  for (const pkg of readdirSync(PACKAGES)) {
    const full = path.join(PACKAGES, pkg);
    if (statSync(full).isDirectory()) walk(full);
  }
  return out;
}

const FILES = sourceFiles();
const READ = new Map(FILES.map((f) => [f, readFileSync(path.join(PACKAGES, f), "utf-8")]));

/** Every arm site every backend declares, flattened, with its backend beside it. */
const SITES = JOURNAL_BACKENDS.filter((b) => b.conformance !== false).flatMap((backend) =>
  backend.arms.map((arm) => ({ ...arm, backend })),
);

/** The case modules, whose bodies must contain no silent skip. */
const CASE_MODULES = [
  "aai-runtime/src/journal-conformance-cases.ts",
  "aai-runtime/src/journal-conformance-codec.ts",
  "aai-runtime/src/journal-conformance-waits.ts",
  "aai-runtime/src/journal-conformance-resume.ts",
];

/**
 * THIS file, excluded from the scans that look for the names it forbids.
 *
 * It names `journalConformance(` as a string literal in CODE rather than in a
 * comment, so stripping comments is not enough — it scored itself as an
 * unregistered arm on its first run. Fourth or fifth time this repo has paid
 * for the same trap: see `SELF_REFERENTIAL` in `scripts/guard-invariants.mjs`,
 * the markdown exclusion in `scripts/check-escape-hatches.mjs`, and
 * `aai-server/store-conformance-registry.test.ts`'s comment stripping.
 */
const SELF = "aai-runtime/src/journal-conformance-arms.test.ts";

/** Comments stripped, because every module here NAMES the thing it forbids. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("every declared journal conformance arm", () => {
  test("really exists as a file in the tree", () => {
    // The assertion the whole file is about. An arm named in the registry and
    // absent from the tree is the state a deletion leaves behind, and it is
    // reported by name and by backend rather than as a puzzle about a loader.
    const missing = SITES.filter((site) => !READ.has(site.file)).map(
      (site) => `${site.backend.backend}: ${site.file}`,
    );
    expect(missing).toEqual([]);
  });

  test("answers the SHARED case list, and not a private one", () => {
    // A file that still exists, still boots a store and still asserts things,
    // but no longer hands the shared list an arm, is a suite of that backend's
    // own choosing wearing a conformance arm's filename.
    for (const site of SITES) {
      const source = READ.get(site.file);
      expect.soft(source, `${site.file} is readable`).toBeDefined();
      expect
        .soft(source?.includes("journalConformance("), `${site.file} invokes journalConformance`)
        .toBe(true);
    }
  });

  test("builds the backend it claims to be an arm OF", () => {
    // Without this an arm could be re-pointed at another backend and still
    // satisfy every assertion above, leaving one backend with two arms and
    // another with none while the registry reads as complete.
    for (const site of SITES) {
      const source = READ.get(site.file) ?? "";
      expect
        .soft(
          source.includes(`${site.backend.factory}(`),
          `${site.file} builds ${site.backend.factory}`,
        )
        .toBe(true);
    }
  });

  test("sits in the TIER it declares, by the repo's naming convention", () => {
    // Membership is the `*.scenario.test.ts` infix (see AGENTS.md, "Test
    // tiers"), so the declaration is checked against the filename rather than
    // believed. A scenario arm promoted to unit would otherwise claim to run
    // unconditionally while running behind `describeWithPg`.
    for (const site of SITES) {
      const isScenario = /\.scenario\.test\.ts$/.test(site.file);
      expect.soft(isScenario, `${site.file} tier=${site.tier}`).toBe(site.tier === "scenario");
    }
  });

  test("says what it can SEE that its siblings cannot", () => {
    // Four arms over one case list is only worth its runtime if each answers
    // something the others structurally cannot — the unit platform arm's own
    // header is emphatic that it "cannot represent a single bug the platform's
    // SQL has actually shipped". An arm with nothing of its own to see is one
    // to delete, and this is where that claim has to be written down.
    for (const site of SITES) {
      expect.soft(site.sees.length, `${site.file} sees`).toBeGreaterThan(20);
    }
    // And distinct: two arms with the same claim means one of them is a copy.
    const seen = SITES.map((site) => site.sees);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("the reverse direction, and the floors under both", () => {
  test("no file answers the case list without being registered as an arm", () => {
    // An arm somebody wrote and nobody declared is as invisible to this gate as
    // one that vanished — it runs today and its absence is unnoticed tomorrow.
    const declared = new Set(SITES.map((site) => site.file));
    const answering = FILES.filter(
      (file) =>
        file !== SELF &&
        /\.test\.ts$/.test(file) &&
        code(READ.get(file) ?? "").includes("journalConformance("),
    );
    // The floor under this one: the scan matching NOTHING passes the filter
    // below and prints the same green. Measured: 3 files answer the list.
    expect(answering.length).toBeGreaterThanOrEqual(3);
    expect(answering.filter((file) => !declared.has(file))).toEqual([]);
  });

  test("the arms really span two tiers and two PACKAGES", () => {
    // The floor. Every assertion above is a loop over `SITES`, so an empty or
    // collapsed registry satisfies all of them and prints the same green — the
    // failure shape this whole file exists for, one level up. Measured: 4 arm
    // sites over 3 backends, 2 tiers, 2 packages.
    expect(SITES.length).toBeGreaterThanOrEqual(4);
    expect(JOURNAL_BACKENDS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(SITES.map((site) => site.tier))).toEqual(new Set(["unit", "scenario"]));
    // Two packages is the property that matters most: the cross-package arm is
    // the one no `tier` field could describe and no gate could name.
    const packages = new Set(SITES.map((site) => site.file.split("/")[0]));
    expect(packages).toEqual(new Set(["aai-runtime", "aai-server"]));
    // And the scan itself resolved something, so a narrowed walk cannot pass
    // quietly — the corpus floor every counting gate in this repo carries, for
    // the reason `scripts/_ratchet.mjs` gives. Measured 1,763 `.ts` files under
    // `packages/`; the floor sits well under it because the tree only grows in
    // ways this assertion has no opinion about.
    expect(FILES.length).toBeGreaterThan(800);
  });

  test("at least one arm still RUNS the resume half", () => {
    // `JournalArm.resumable` is what excludes the ten `resumableRuns` cases on a
    // backend that declares no such method, and the exclusion is now reported
    // rather than returned out of. That leaves one way for those ten cases to go
    // quiet again in bulk: every arm declaring `false`, which the reporter would
    // print as forty deliberate skips. Read out of the arm files, since the
    // declaration is the ARM's rather than the registry's.
    // De-duplicated by FILE, because two arms share `journal-conformance.test.ts`
    // (memory, and the platform over a fake transport) — one of which declares
    // `true` and one `false`, so this can only ever be a claim about the file.
    const running = [
      ...new Set(
        SITES.filter((site) => /resumable:\s*true/.test(READ.get(site.file) ?? "")).map(
          (site) => site.file,
        ),
      ),
    ].sort();
    expect(running).toEqual([
      "aai-runtime/src/journal-conformance-postgres.scenario.test.ts",
      "aai-runtime/src/journal-conformance.test.ts",
    ]);
  });

  test("no case body skips itself with a bare return", () => {
    // The other half of the same defect, pinned so it cannot come back. Ten of
    // the 69 shared cases opened `if (!journal) return;` over their assertions,
    // so on both platform arms they printed a green checkmark at 0 ms directly
    // beside the memory arm's ten real passes — a skip that announces nothing is
    // indistinguishable from a pass at every level anyone looks at, which is
    // exactly what `check:test-assertions` exists to catch one layer up and
    // structurally cannot see here (the `expect` is present, just unreached).
    for (const module of CASE_MODULES) {
      const source = READ.get(module);
      expect.soft(source, `${module} is readable`).toBeDefined();
      const bare = code(source ?? "")
        .split("\n")
        .map((line, n) => [n + 1, line] as const)
        .filter(([, line]) => /^\s*(?:if\s*\(.*\)\s*)?return;\s*$/.test(line))
        .map(([n, line]) => `${module}:${n} ${line.trim()}`);
      expect.soft(bare, module).toEqual([]);
    }
  });
});
