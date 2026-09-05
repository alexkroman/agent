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
import { byCodeUnit, repoPathOf, sole } from "./_gate-support.ts";

/** Every committed per-entry-point report, keyed by path relative to this file. */
const reports: Record<string, string> = import.meta.glob("../../*/etc/*.api.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const combined: string | undefined = sole(
  import.meta.glob<string>("../../../API.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/**
 * The same text, never absent — its readability is asserted in its own case
 * below, and the four readers after that work on a string rather than each
 * spelling `combined ?? ""` again.
 */
const api: string = combined ?? "";

/**
 * The exported lines inside a report's ```ts fence, one per line.
 *
 * Deliberately a different parse from the script's: it takes the lines that
 * export something rather than the fence's whole body, so the two agree only
 * when the content really made it across. Comparing bodies verbatim would just
 * re-run the script's own extraction and pass whenever that extraction is
 * consistently wrong.
 *
 * The bare `export { X }` form is counted because an entry point can be ALL
 * re-export — `@alexkroman1/aai-runtime/internal` passes on 31 names from the
 * SDK and DECLARES nothing — and a declaration-only parser reads such a report
 * as empty, which is indistinguishable here from a parser that stopped working.
 */
const declarations = (report: string): string[] =>
  report
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter(
      (line) =>
        /^export (declare )?(abstract class|class|const|enum|function|interface|type)\s/.test(
          line,
        ) || /^export (type )?\{ \w+ \}$/.test(line),
    );

const entries = Object.entries(reports)
  .map(([key, text]) => ({ path: repoPathOf(key), declarations: declarations(text) }))
  .sort((a, b) => byCodeUnit(a.path, b.path));

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
    expect(api.length).toBeGreaterThan(50_000);
  });

  test("it names every entry point in its contents list", () => {
    const listed = [...api.matchAll(/^- `([^`]+)` — `([^`]+)`$/gm)].map((match) => ({
      // Both groups are non-optional in the pattern, so a match has both;
      // `noUncheckedIndexedAccess` types them as possibly absent regardless.
      specifier: match[1] ?? "",
      reportPath: match[2] ?? "",
    }));
    // Sorted on both sides: the file is written in generation order (package,
    // then entry-point slug), which is not the path order `entries` carries.
    expect(
      listed.map((item) => item.reportPath).sort(byCodeUnit),
      `API.md lists ${listed.length} entry point(s), the repo has ${entries.length}. ${remedy}`,
    ).toEqual(entries.map((entry) => entry.path));
    // The contents list and the sections have to agree, or the list is a map of
    // a file that is not there.
    for (const { specifier } of listed) {
      expect(api.includes(`\n## \`${specifier}\`\n`), `no section for ${specifier}`).toBe(true);
    }
  });

  test.each(entries)("$path made it into API.md", ({ path, declarations: lines }) => {
    const missing = lines.filter((line) => !api.includes(line));
    expect(
      missing,
      `${missing.length} declaration(s) from ${path} are absent from API.md, ` +
        `starting with: ${missing[0]}. ${remedy}`,
    ).toEqual([]);
  });
});

/**
 * One symbol, one release tag.
 *
 * API Extractor writes the tag per DECLARATION, so a symbol with overloads gets
 * one comment per signature — and an `@internal` on the first overload alone
 * leaves the rest defaulting to `@public`. The result is a name the two
 * committed artifacts disagree about: `API-EXPORTS.json` lists it as published
 * while TypeDoc drops the whole symbol (one internal declaration wins) and
 * `docs/api` denies it exists. That is not a rendering preference — it is a
 * published export the reference says is not there, and it is invisible in a
 * diff because each half of the pair reads correctly on its own.
 *
 * `assertProviderTriple` on `/manifest` was the one occurrence and is gone; the
 * gate is absolute, with no allowlist, because there is no symbol that is
 * rightly both.
 */
describe("release tags", () => {
  /** A `// @public` / `// @internal` line, with the tag captured. */
  const tagLine = /^\/\/ (@(?:public|internal|beta|alpha))\b/;

  /**
   * The name the declaration a tag comment introduces declares.
   *
   * `includeForgottenExports` is on, so a declaration may carry no `export`
   * keyword; overloads and `declare` forms are the other shapes here.
   */
  const declaredName =
    /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|const|enum|function|interface|type|let|var|namespace)\s+([A-Za-z_$][\w$]*)/;

  /** Every tagged declaration in one report, as `{ name, tag }`. */
  const taggedDeclarations = (report: string): { name: string; tag: string }[] => {
    const lines = report.replaceAll("\r\n", "\n").split("\n");
    const found: { name: string; tag: string }[] = [];
    for (const [index, line] of lines.entries()) {
      const tag = tagLine.exec(line)?.[1];
      if (tag === undefined) continue;
      // The comment sits directly above its declaration, blank lines aside.
      let next = index + 1;
      while (next < lines.length && (lines[next] ?? "").trim() === "") next += 1;
      const name = declaredName.exec(lines[next] ?? "")?.[1];
      // A tag whose declaration this cannot read is reported by its own case
      // below rather than skipped: an unparsed line is a symbol this gate stops
      // covering, which is the failure the whole file exists to catch.
      found.push({ name: name ?? "", tag });
    }
    return found;
  };

  const tagged = Object.entries(reports).map(([key, text]) => ({
    path: repoPathOf(key),
    declarations: taggedDeclarations(text),
  }));

  const all = tagged.flatMap((entry) => entry.declarations);

  test("the tag comments are being read", () => {
    // Both floors are under the measured actuals (1078 tagged declarations,
    // none unparsed) for the reason every count-only gate here carries one: a
    // pattern that stopped matching prints the same green as a clean tree.
    expect(all.length).toBeGreaterThanOrEqual(900);
    const unparsed = tagged.flatMap((entry) =>
      entry.declarations.filter((decl) => decl.name === "").map(() => entry.path),
    );
    expect(unparsed, `${unparsed.length} tag comment(s) sit above an unreadable line`).toEqual([]);
  });

  test.each(tagged)("$path gives each symbol one release tag", ({ path, declarations }) => {
    const tagsByName = new Map<string, Set<string>>();
    for (const { name, tag } of declarations) {
      const tags = tagsByName.get(name) ?? new Set<string>();
      tags.add(tag);
      tagsByName.set(name, tags);
    }
    const split = [...tagsByName]
      .filter(([, tags]) => tags.size > 1)
      .map(([name, tags]) => `${name} (${[...tags].sort().join(" + ")})`);
    expect(
      split,
      `${path} tags ${split.length} symbol(s) two ways: ${split.join(", ")}. ` +
        "Every overload of one symbol needs the same release tag — put the tag " +
        "on the implementation signature, or on all of them.",
    ).toEqual([]);
  });
});
