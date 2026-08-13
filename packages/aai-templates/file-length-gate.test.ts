// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Guards the HEADROOM half of `scripts/check-file-length.mjs`.
 *
 * The cap itself has never been the expensive part. What costs time is
 * learning about it late: a file already at 500 lines is one the next feature
 * has to split, and a split discovered mid-change lands as an unrelated
 * refactor inside a diff that was about something else. Branches here have
 * carried several of those — "moved X into its own module to stay under the
 * cap" as an afterthought commit, repeatedly, in one branch.
 *
 * So the gate reports what is CLOSE to its cap, and the pre-commit hook prints
 * it for staged files. Both halves fail quietly if they rot: the report is
 * advisory, so nothing goes red when it stops selecting files, and the hook
 * line can be deleted without any test noticing. This suite pins them.
 *
 * Assertions are made against the script's SOURCE, the way
 * `test-assertion-gate.test.ts` and `escape-hatch-scope.test.ts` do: this
 * package's tsconfig has no node types, so a spec here cannot spawn the gate
 * or import its node-builtin-using module — it reads the file that CI runs.
 */

import { describe, expect, test } from "vitest";

const script = import.meta.glob("../../scripts/check-file-length.mjs", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../scripts/check-file-length.mjs"];

const lefthook = import.meta.glob("../../lefthook.yml", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../lefthook.yml"];

/** Read a numeric constant out of the script rather than restating it here. */
function constant(name: string): number {
  const found = new RegExp(`const ${name} = ([\\d._]+)`).exec(script ?? "");
  if (!found?.[1]) throw new Error(`check-file-length.mjs no longer declares ${name}`);
  return Number(found[1].replaceAll("_", ""));
}

/** The body of the first `if (<cond>) {` block whose condition matches. */
function block(opener: string): string {
  const at = (script ?? "").indexOf(opener);
  if (at === -1) throw new Error(`check-file-length.mjs no longer contains \`${opener}\``);
  const from = at + opener.length;
  let depth = 1;
  for (let i = from; i < (script ?? "").length; i++) {
    const ch = script?.[i];
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return (script ?? "").slice(from, i);
  }
  throw new Error(`check-file-length.mjs: unbalanced braces after \`${opener}\``);
}

describe("check-file-length", () => {
  test("the script is present and declares its caps", () => {
    expect(script, "scripts/check-file-length.mjs not found").toBeTypeOf("string");
    expect(constant("SOURCE_MAX")).toBe(500);
    expect(constant("TEST_MAX")).toBe(700);
  });

  test("the warn ratio leaves a margin worth acting on", () => {
    const ratio = constant("WARN_RATIO");
    // At 1.0 the report only fires once a file is already at the cap, which is
    // the situation it exists to get ahead of; below ~0.75 it names most of the
    // repo and gets skimmed.
    expect(ratio).toBeGreaterThanOrEqual(0.75);
    expect(ratio).toBeLessThan(1);
  });

  test("the near-cap selection is derived from the ratio, not a second number", () => {
    // A hardcoded threshold beside a WARN_RATIO constant is how the constant
    // becomes decorative and the two disagree.
    expect(script).toMatch(/ceiling \* WARN_RATIO/);
  });

  test("headroom is measured against a grandfathered file's own ceiling", () => {
    // A file in the allowlist may not pass ITS ceiling, which is the number it
    // has left — measuring against the 500/700 cap would report an allowlisted
    // 800-line file as 300 lines over budget and never as approaching a limit.
    expect(script).toMatch(/remaining: ceiling - lines/);
    expect(script).toMatch(/const ceiling = path in allowlist \? allowlist\[path\] : cap/);
  });

  test("the scripts pathspec reaches the TOP level, not just subdirectories", () => {
    // A git pathspec is fnmatch without FNM_PATHNAME, so `*` already crosses
    // `/` and `scripts/**/*.mjs` parses as "scripts/" + anything + "/" +
    // anything + ".mjs" — the literal slash makes a subdirectory mandatory. The
    // gate shipped with only that glob, so it measured the six files under
    // scripts/starter-eval/ and none of the ~25 at the top level, which is
    // where its own comment says an unreviewed 900-line harness hides. It
    // printed "all files within caps ✓" throughout.
    // Matched with the quotes, so the prose in the gate's own comment (which
    // names the broken glob in backticks) cannot satisfy these.
    for (const pattern of ['"scripts/*.mjs"', '"scripts/*.ts"']) {
      expect(script, `check-file-length.mjs must measure ${pattern}`).toContain(pattern);
    }
    // The nested globs stay: neither shape subsumes the other.
    expect(script).toContain('"scripts/**/*.mjs"');
    expect(script).toContain('"scripts/**/*.ts"');
    // `packages/**/*.ts` needs no top-level twin — every source file there is
    // at least one directory deep, so the same trap cannot fire.
    expect(script).toContain('"packages/**/*.ts"');
  });

  test("staged mode cannot block a commit", () => {
    // It runs on every commit. A gate there teaches `--no-verify`, which would
    // also skip the pre-push hook that runs the whole check suite.
    expect(block("if (STAGED) {")).toContain("process.exit(0)");
  });

  test("the pre-commit hook prints the staged headroom report", () => {
    expect(lefthook, "lefthook.yml not found").toBeTypeOf("string");
    expect(lefthook).toContain("check-file-length.mjs --staged");
  });

  test("the cap is still enforced by the local check and CI", () => {
    // Same reasoning as claude-md-limit.test.ts: the ratchets once lived only
    // in check.sh, which CI never invokes, so `git push --no-verify` skipped
    // them entirely.
    const files: Record<string, string | undefined> = {
      "package.json": import.meta.glob("../../package.json", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../package.json"],
      "scripts/check.sh": import.meta.glob("../../scripts/check.sh", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../scripts/check.sh"],
      ".github/workflows/check.yml": import.meta.glob("../../.github/workflows/check.yml", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../.github/workflows/check.yml"],
    };
    for (const [path, text] of Object.entries(files)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:file-length`).toContain("check:file-length");
    }
  });
});
