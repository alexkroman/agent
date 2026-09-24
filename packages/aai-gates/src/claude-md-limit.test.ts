// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Every agent guide must stay small enough to be read whole — in two tiers,
 * mirroring `scripts/check-claude-md.mjs` (whose header carries the argument).
 *
 * - AUTO-LOADED (`AGENTS.md`, every package or directory `CLAUDE.md`,
 *   `docs/CLAUDE.md`): `AUTO_BUDGET`, or the file's shrink-only entry in
 *   `scripts/claude-md-baseline.json`.
 * - REFERENCE (`*-CLAUDE.md` siblings, `.agents/*.md`, the scaffold guide):
 *   `REFERENCE_BUDGET`, 20% under the `HARD_LIMIT` past which a read silently
 *   drops the rest.
 *
 * Reads its subjects as TEXT (`?raw`) — this package has no node types — and
 * the last tests keep the script's caps and wiring in step with these.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, GATE_WIRING, numericConstant, repoPathOf, sole } from "./_gate-support.ts";

/** The point past which an agent's context silently drops the remainder. */
const HARD_LIMIT = 150_000;
/** Cap for a file read on demand — 20% under the hard limit. */
const REFERENCE_BUDGET = 120_000;
/** Cap for a guide Claude Code loads unasked. */
const AUTO_BUDGET = 40_000;

// One glob per shape so a miss is obvious. `import.meta.glob` is a
// compile-time transform: every argument must be a literal.
const guides: Record<string, string> = {
  ...import.meta.glob("../../../AGENTS.md", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../../docs/CLAUDE.md", { query: "?raw", import: "default", eager: true }),
  // Package-root guides.
  ...import.meta.glob("../../*/CLAUDE.md", { query: "?raw", import: "default", eager: true }),
  // Directory guides below a package's `src/` (the product trees — scaffold,
  // templates — sit outside `src/`, so they are not matched).
  ...import.meta.glob("../../*/src/**/CLAUDE.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  // Siblings: `MODAL-CLAUDE.md`, `S2S-CLAUDE.md`, …
  ...import.meta.glob("../../*/*-CLAUDE.md", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../*/scaffold/CLAUDE.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../.agents/*.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

/** The root `CLAUDE.md` shim, read separately — it is pinned, not measured. */
const rootShim = sole(
  import.meta.glob("../../../CLAUDE.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const baselineFile = sole(
  import.meta.glob<{ guides?: Record<string, number> }>(
    "../../../scripts/claude-md-baseline.json",
    {
      import: "default",
      eager: true,
    },
  ),
);
const baseline: Record<string, number> = baselineFile?.guides ?? {};

/** Same rule as `tierOf` in the script: any non-product `CLAUDE.md` is auto-loaded. */
const PRODUCT = /^packages\/aai-templates\/(scaffold|templates)\//;
const tierOf = (path: string): "auto" | "reference" =>
  path === "AGENTS.md" || (/(^|\/)CLAUDE\.md$/.test(path) && !PRODUCT.test(path))
    ? "auto"
    : "reference";

const entries = Object.entries(guides)
  .map(([key, text]) => ({ path: repoPathOf(key), text }))
  .map((e) => ({ ...e, tier: tierOf(e.path) }))
  .sort((a, b) => byCodeUnit(a.path, b.path));
const autoEntries = entries.filter((e) => e.tier === "auto");
const referenceEntries = entries.filter((e) => e.tier === "reference");

const remedy =
  "Move a section into the CLAUDE.md of the directory whose files it governs " +
  "(or a *-CLAUDE.md sibling / .agents/ file if it is reference), leave a " +
  'pointer, and cut history — see AGENTS.md, "Updating agent guides". Only the ' +
  "scaffold guide, which ships to users, has to be cut instead.";

describe("agent guide size", () => {
  test("the guides are discovered", () => {
    // A broken glob would make every assertion below vacuously pass.
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain("docs/CLAUDE.md");
    expect(paths).toContain("packages/aai/CLAUDE.md");
    expect(paths).toContain("packages/aai-templates/CLAUDE.md");
    expect(paths).toContain("packages/aai-templates/scaffold/CLAUDE.md");
    expect(paths).toContain(".agents/ratchets.md");
    expect(entries.length).toBeGreaterThanOrEqual(9);
    expect(baselineFile, "scripts/claude-md-baseline.json not found").toBeTypeOf("object");
  });

  test("the tiers are assigned by the script's rule", () => {
    expect(tierOf("AGENTS.md")).toBe("auto");
    expect(tierOf("docs/CLAUDE.md")).toBe("auto");
    expect(tierOf("packages/aai/CLAUDE.md")).toBe("auto");
    expect(tierOf("packages/aai-server/src/sandbox/CLAUDE.md")).toBe("auto");
    expect(tierOf("packages/aai/S2S-CLAUDE.md")).toBe("reference");
    expect(tierOf(".agents/ratchets.md")).toBe("reference");
    expect(tierOf("packages/aai-templates/scaffold/CLAUDE.md")).toBe("reference");
    expect(tierOf("packages/aai-templates/templates/x/CLAUDE.md")).toBe("reference");
  });

  test.each(autoEntries)("auto-loaded $path is within its budget", ({ path, text }) => {
    const recorded = baseline[path];
    if (recorded === undefined) {
      expect(
        text.length,
        `${path} is ${text.length} chars — over the ${AUTO_BUDGET} char cap for an ` +
          `auto-loaded guide. ${remedy}`,
      ).toBeLessThanOrEqual(AUTO_BUDGET);
      return;
    }
    expect(
      text.length,
      `${path} is ${text.length} chars — past its shrink-only baseline of ${recorded} ` +
        `in scripts/claude-md-baseline.json. ${remedy}`,
    ).toBeLessThanOrEqual(recorded);
    expect(
      text.length,
      `${path} shrank to ${text.length} chars under its baseline of ${recorded} — ` +
        "run `pnpm claude-md:update` to lock the gain in.",
    ).toBe(recorded);
  });

  test.each(referenceEntries)("reference $path is within its budget", ({ path, text }) => {
    // Two lines: over the budget is "refactor before adding more", over the
    // hard limit is "an agent is reading a truncated file".
    expect(
      text.length,
      `${path} is ${text.length} chars — past the ${HARD_LIMIT} char limit, so an ` +
        `agent reading it silently loses the rest. ${remedy}`,
    ).toBeLessThanOrEqual(HARD_LIMIT);
    expect(
      text.length,
      `${path} is ${text.length} chars — over the ${REFERENCE_BUDGET} char budget. ${remedy}`,
    ).toBeLessThanOrEqual(REFERENCE_BUDGET);
  });

  test("every baseline entry names an existing auto-loaded guide", () => {
    // A stale entry is budget nobody can see being spent. The script also
    // lists nested guides outside `src/`, which these globs do not; the
    // baseline only ever holds guides both see.
    const auto = new Set(autoEntries.map((e) => e.path));
    for (const [path, recorded] of Object.entries(baseline)) {
      expect(auto.has(path), `${path} is baselined but is not an auto-loaded guide`).toBe(true);
      expect(Number.isInteger(recorded)).toBe(true);
      expect(recorded, `${path}'s entry is at or under the cap — remove it`).toBeGreaterThan(
        AUTO_BUDGET,
      );
      expect(recorded).toBeLessThanOrEqual(REFERENCE_BUDGET);
    }
  });

  test("the root CLAUDE.md is only an import of AGENTS.md", () => {
    // Both names must resolve to ONE guide. A CLAUDE.md that grew content back
    // would be loaded by Claude Code and ignored by every other agent tool, so
    // the divergence has no symptom until an agent reads the stale half.
    expect(rootShim, "root CLAUDE.md not found").toBeTypeOf("string");
    expect(rootShim?.trim()).toBe("@AGENTS.md");
  });

  test("the root guide points at every package guide", () => {
    const root = guides["../../../AGENTS.md"];
    if (!root) throw new Error("root AGENTS.md not found");
    // A guide nothing links to is a guide nobody opens: AGENTS.md's generated
    // tables (package, sibling, directory) are the only index, since Claude
    // Code auto-loads a guide only once you are working in its directory.
    const packageGuides = entries
      .map((e) => e.path)
      .filter((p) => p.startsWith("packages/") && !p.includes("/scaffold/"));
    expect(packageGuides.length).toBeGreaterThan(0);
    for (const path of packageGuides) {
      expect(root, `the root CLAUDE.md does not mention ${path}`).toContain(path);
    }
  });

  test("the standalone gate enforces the same budgets", () => {
    // Duplicated by necessity (the script has no bundler, this suite no node
    // types), so assert the two agree rather than let one drift.
    const script = sole(
      import.meta.glob("../../../scripts/check-claude-md.mjs", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    );
    if (!script) throw new Error("scripts/check-claude-md.mjs not found");
    const file = "scripts/check-claude-md.mjs";
    expect(numericConstant(script, "MAX_AUTO_CHARS", file)).toBe(AUTO_BUDGET);
    expect(numericConstant(script, "MAX_REFERENCE_CHARS", file)).toBe(REFERENCE_BUDGET);
    expect(script).toContain('"scripts/claude-md-baseline.json"');
    expect(script).toContain(PRODUCT.source);

    // It warns BEFORE a cap — advisory, so nothing else would notice it gone.
    const ratio = numericConstant(script, "WARN_RATIO", file);
    expect(ratio).toBeGreaterThanOrEqual(0.75);
    expect(ratio).toBeLessThan(1);
    expect(script).toContain("g.cap * WARN_RATIO");
  });

  test("the gate is wired into both the local check and CI", () => {
    // A gate only in the local check is skipped by `git push --no-verify`.
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:claude-md`).toContain("check:claude-md");
    }
  });
});
