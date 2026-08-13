// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `API.md` is the whole published surface in one file — and it must really
 * contain it.
 *
 * `scripts/api-report.mjs --check` already compares the committed file against
 * a freshly assembled one, which catches staleness and nothing else. The
 * failure it cannot see is the assembly itself going thin: if the concatenation
 * loop stopped finding entry points, or the fence parser stopped matching API
 * Extractor's output, `--check` would compare an empty file against an empty
 * file and print its checkmark. That is the shape this repo keeps paying for —
 * a gate whose entire success output is a count, agreeing with itself.
 *
 * So this suite reads the per-entry-point reports and `API.md` INDEPENDENTLY of
 * the script and asserts the second contains the first. It lives in
 * aai-templates for the same reason `claude-md-limit.test.ts` does: raw imports
 * reach the sibling packages and the repo root, and this package's tsconfig
 * pulls in no node types.
 */

import { describe, expect, test } from "vitest";

/** Every committed per-entry-point report, keyed by path relative to this file. */
const reports: Record<string, string> = import.meta.glob("../*/etc/*.api.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const combined = import.meta.glob("../../API.md", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../API.md"] as string | undefined;

/** `../aai/etc/stt.api.md` -> `packages/aai/etc/stt.api.md`. */
const repoPath = (key: string): string => `packages/${key.slice("../".length)}`;

/**
 * The declarations inside a report's ```ts fence, one per line.
 *
 * Deliberately a different parse from the script's: it takes the lines that
 * declare something rather than the fence's whole body, so the two agree only
 * when the content really made it across. Comparing bodies verbatim would just
 * re-run the script's own extraction and pass whenever that extraction is
 * consistently wrong.
 */
const declarations = (report: string): string[] =>
  report
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) =>
      /^export (declare )?(abstract class|class|const|enum|function|interface|type)\s/.test(line),
    );

const entries = Object.entries(reports)
  .map(([key, text]) => ({ path: repoPath(key), declarations: declarations(text) }))
  .sort((a, b) => a.path.localeCompare(b.path));

const remedy = "Run `pnpm api-report` and commit API.md.";

describe("API.md", () => {
  test("the reports are discovered", () => {
    // A broken glob would make every assertion below vacuously pass — which is
    // the exact failure this file exists to catch one level up.
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain("packages/aai/etc/index.api.md");
    expect(paths).toContain("packages/aai-ui/etc/index.api.md");
    expect(paths).toContain("packages/aai-cli/etc/typecheck.api.md");
    expect(entries.length).toBeGreaterThanOrEqual(20);
    expect(entries.every((entry) => entry.declarations.length > 0)).toBe(true);
  });

  test("it exists and is not empty", () => {
    expect(combined, `API.md is missing. ${remedy}`).toBeTypeOf("string");
    // Every report has a heading and a fence of its own, so the combined file
    // is necessarily larger than any one of them.
    expect((combined ?? "").length).toBeGreaterThan(50_000);
  });

  test("it names every entry point in its contents list", () => {
    const listed = [...(combined ?? "").matchAll(/^- `([^`]+)` — `([^`]+)`$/gm)].map((match) => ({
      // Both groups are non-optional in the pattern, so a match has both;
      // `noUncheckedIndexedAccess` types them as possibly absent regardless.
      specifier: match[1] ?? "",
      reportPath: match[2] ?? "",
    }));
    // Sorted on both sides: the file is written in generation order (package,
    // then entry-point slug), which is not the path order `entries` carries.
    expect(
      listed.map((item) => item.reportPath).sort((a, b) => a.localeCompare(b)),
      `API.md lists ${listed.length} entry point(s), the repo has ${entries.length}. ${remedy}`,
    ).toEqual(entries.map((entry) => entry.path));
    // The contents list and the sections have to agree, or the list is a map of
    // a file that is not there.
    for (const { specifier } of listed) {
      expect(
        (combined ?? "").includes(`\n## \`${specifier}\`\n`),
        `no section for ${specifier}`,
      ).toBe(true);
    }
  });

  test.each(entries)("$path made it into API.md", ({ path, declarations: lines }) => {
    const missing = lines.filter((line) => !(combined ?? "").includes(line));
    expect(
      missing,
      `${missing.length} declaration(s) from ${path} are absent from API.md, ` +
        `starting with: ${missing[0]}. ${remedy}`,
    ).toEqual([]);
  });
});
