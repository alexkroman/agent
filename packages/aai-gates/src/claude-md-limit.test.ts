// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Every agent guide must stay small enough to be read WHOLE.
 *
 * The ROOT guide is `AGENTS.md` — the name every agent tool reads — and the
 * root `CLAUDE.md` is a one-line `@AGENTS.md` import so Claude Code resolves
 * the same file. Package guides stay `CLAUDE.md`, which is what Claude Code
 * auto-loads when working in that directory. The last test here pins the shim:
 * content pasted into it would be read by Claude Code and by nothing else, so
 * the two copies would diverge with no symptom.
 *
 * An agent loads these guides into its context in full, and past ~150k
 * characters the rest of the file is dropped — silently. That is the whole
 * failure mode: nothing warns, no tool errors, the guide is simply
 * half-present and the agent works from whichever half survived. The root
 * guide reached 233k that way, one well-justified paragraph at a time, and
 * every paragraph looked like a good idea on its own.
 *
 * So this suite enforces two lines, not one:
 *
 * - `HARD_LIMIT` (150k) — a file over this is being truncated RIGHT NOW.
 * - `BUDGET` (120k, 20% under) — the working cap, so the next author can add
 *   a section without having to split a file mid-task.
 *
 * **The fix is almost never to delete rationale.** Move the section into the
 * package that owns the surface — Claude Code loads a package's `CLAUDE.md`
 * when working in that directory — and leave a pointer in the root's
 * "Package guides" table. `scaffold/CLAUDE.md` is the one exception: it is
 * embedded in the studio system prompt and ships to users inside the
 * `@alexkroman1/aai` tarball as `AGENT_GUIDE.md`, so it has no packages to
 * push sections into and the answer there really is to cut. Splitting it
 * behind a `@path` import would not buy anything either — imports are expanded
 * at launch, which is also why `aai init` writes a POINTER at the SDK copy as
 * a project's `CLAUDE.md` rather than copying this file into it.
 *
 * This lives in aai-templates because that package owns the documentation
 * shipped to users (the scaffold guide above), and because raw imports reach
 * the sibling guides with no node types — this package's tsconfig has none.
 * `pnpm check:claude-md` runs the same cap over `git ls-files` in
 * `scripts/check.mjs`, the pre-push hook, and the CI check job; the last test
 * here is what keeps the two from drifting apart.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, GATE_WIRING, repoPathOf, sole } from "./_gate-support.ts";

/** The point past which an agent's context silently drops the remainder. */
const HARD_LIMIT = 150_000;
/** 20% under the hard limit — headroom for the next section. */
const BUDGET = 120_000;

// Three globs rather than one brace pattern, so a miss is obvious: the root
// guide (AGENTS.md), one per workspace package, and the scaffold guide shipped
// to users. `import.meta.glob` is a compile-time transform, so every argument
// has to be a literal — the options object cannot be hoisted into a shared
// constant.
const guides: Record<string, string> = {
  ...import.meta.glob("../../../AGENTS.md", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../*/CLAUDE.md", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../*/scaffold/CLAUDE.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  // The on-demand references AGENTS.md's "Detailed references" table points
  // at. Measured on the same budget: they exist so the root guide can stay
  // small, and an agent following a pointer reads one whole. Capping only the
  // root would relocate the failure into a file nothing measures.
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

// `repoPathOf` knows all three shapes a key arrives in — the repo root, a
// sibling package, and this package (which is what the sibling-package glob
// reports aai-templates' own guide under). See `_gate-support.ts`.
const entries = Object.entries(guides)
  .map(([key, text]) => ({ path: repoPathOf(key), text }))
  .sort((a, b) => byCodeUnit(a.path, b.path));

const remedy =
  "Move sections into the owning package's CLAUDE.md and leave a pointer in " +
  'the root guide\'s "Package guides" table, or — for a repo-wide section that ' +
  "is REFERENCE rather than something every task needs — into .agents/ and its " +
  '"Detailed references" table (see "Updating AGENTS.md"). Only the scaffold ' +
  "guide, which ships to users, has to be cut instead.";

describe("agent guide size", () => {
  test("the guides are discovered", () => {
    // A broken glob would make every assertion below vacuously pass.
    expect(entries.map((e) => e.path)).toContain("AGENTS.md");
    expect(entries.map((e) => e.path)).toContain("packages/aai/CLAUDE.md");
    expect(entries.map((e) => e.path)).toContain("packages/aai-templates/scaffold/CLAUDE.md");
    expect(entries.map((e) => e.path)).toContain("packages/aai-templates/CLAUDE.md");
    expect(entries.map((e) => e.path)).toContain(".agents/ratchets.md");
    expect(entries.length).toBeGreaterThanOrEqual(9);
  });

  // Two separate assertions on purpose: over BUDGET is "refactor before you
  // add more", over HARD_LIMIT is "an agent is reading a truncated file".
  test.each(entries)("$path is within the agent context limit", ({ path, text }) => {
    expect(
      text.length,
      `${path} is ${text.length} chars — past the ${HARD_LIMIT} char limit, so ` +
        `an agent reading it silently loses everything after that point. ${remedy}`,
    ).toBeLessThanOrEqual(HARD_LIMIT);

    expect(
      text.length,
      `${path} is ${text.length} chars — over the ${BUDGET} char budget ` +
        `(20% under the ${HARD_LIMIT} limit). ${remedy}`,
    ).toBeLessThanOrEqual(BUDGET);
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
    // A package guide nothing links to is a guide nobody opens: the root's
    // table is the only index, since Claude Code only auto-loads a package's
    // guide once you are already working in that directory.
    const packageGuides = entries
      .map((e) => e.path)
      .filter((p) => p.startsWith("packages/") && !p.includes("/scaffold/"));
    expect(packageGuides.length).toBeGreaterThan(0);
    for (const path of packageGuides) {
      expect(root, `the root CLAUDE.md does not mention ${path}`).toContain(path);
    }
  });

  test("the standalone gate enforces the same budget", () => {
    // The cap is duplicated by necessity — the script runs with no bundler,
    // this suite with no node types — so assert the two agree rather than
    // letting one drift into being decorative.
    const script = sole(
      import.meta.glob("../../../scripts/check-claude-md.mjs", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    );
    if (!script) throw new Error("scripts/check-claude-md.mjs not found");
    const declared = script.match(/const MAX_CHARS = ([\d_]+)/)?.[1];
    expect(declared, "scripts/check-claude-md.mjs no longer declares MAX_CHARS").toBeTypeOf(
      "string",
    );
    expect(Number(declared?.replaceAll("_", ""))).toBe(BUDGET);

    // And it warns BEFORE the cap. A guide gains a paragraph as a side effect
    // of shipping something else, so the author who trips the cap is never the
    // one who filled it — and the fix is a documentation refactor landing
    // inside an unrelated change. Two guides sit above 99% today, which is the
    // state this warning exists to announce while there is still room to plan
    // the split. It is advisory by design, so nothing else would notice it
    // being deleted.
    const ratio = Number(script.match(/const WARN_RATIO = ([\d.]+)/)?.[1]);
    expect(
      ratio,
      "scripts/check-claude-md.mjs no longer declares WARN_RATIO",
    ).toBeGreaterThanOrEqual(0.75);
    expect(ratio).toBeLessThan(1);
    // Derived from the constant rather than a second hardcoded threshold.
    expect(script).toContain("MAX_CHARS * WARN_RATIO");
  });

  test("the gate is wired into both the local check and CI", () => {
    // The repo has been here before: the quality ratchets lived only in
    // the local check script, which CI never invokes, so `git push --no-verify`
    // was enough
    // to skip them entirely.
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:claude-md`).toContain("check:claude-md");
    }
  });
});
