// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `API-INDEX.md` is the reverse index over the published surface — every name
 * against the subpath to import it from — and it must really invert it.
 *
 * `scripts/api-report.mjs --check` compares the committed file against a
 * freshly generated one, which catches staleness and nothing else. The failure
 * it cannot see is the inversion going thin: an export scan that stopped
 * matching would generate an empty index, and `--check` would report it as
 * "out of date" — an invitation to regenerate and commit the empty file. The
 * script's own floor catches a total collapse; what it cannot catch is the
 * index disagreeing with `API-EXPORTS.json`, which is the artifact it is
 * derived from and the one a reader would otherwise have to grep instead.
 *
 * So this suite reads both files INDEPENDENTLY of the script and asserts the
 * index is exactly that JSON turned inside out.
 * It reads its subject as TEXT (`?raw`, eager) rather than importing it: this
 * package's tsconfig pulls in no node types, and a spec that imported the
 * script it guards would be asserting a module against itself.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, sole } from "./_gate-support.ts";

const index: string =
  sole(
    import.meta.glob<string>("../../../API-INDEX.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";

const exportsJson: string =
  sole(
    import.meta.glob<string>("../../../API-EXPORTS.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";

const remedy = "Run `pnpm api-report` and commit API-INDEX.md.";

/** The same deny-list `indexFile` applies, restated so the two must agree. */
const isInternal = (specifier: string): boolean => /\/(?:internal|host-internal)$/.test(specifier);

/** `{ name -> subpaths }`, built from the JSON rather than from the index. */
function expectedIndex(): { authoring: Map<string, string[]>; internal: Map<string, string[]> } {
  const surface: Record<string, string[]> = JSON.parse(exportsJson);
  const authoring = new Map<string, string[]>();
  const internal = new Map<string, string[]>();
  for (const [specifier, names] of Object.entries(surface)) {
    const target = isInternal(specifier) ? internal : authoring;
    for (const name of names) target.set(name, [...(target.get(name) ?? []), specifier]);
  }
  for (const name of authoring.keys()) internal.delete(name);
  return { authoring, internal };
}

/** The public sections, in the order the index writes them. */
const PUBLIC_SECTIONS = [
  "Agent authoring",
  "Browser client",
  "Testing and evals",
  "Hosting and tooling",
];

/** Every backticked token in one table cell. */
const ticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

/**
 * `{ name -> subpaths }` for the rows under one `##` heading.
 *
 * A row is `| names | kind | imports | capability | summary |`. The name cell
 * may fold `FooProps` / `FooOptions` beside `Foo` — each is its own entry
 * here, under the same subpaths — and the import cell lists the preferred
 * subpath first, so the subpaths are compared as a SORTED list. A summary's
 * own `|` is escaped, so cells split on an unescaped one.
 */
function rowsUnder(heading: string): Map<string, string[]> {
  const start = index.indexOf(`\n## ${heading}\n`);
  if (start < 0) return new Map();
  const rest = index.slice(start + 1);
  const nextHeading = rest.indexOf("\n## ");
  const body = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  const rows = new Map<string, string[]>();
  for (const line of body.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line.split(/(?<!\\)\|/);
    const specifiers = ticked(cells[3] ?? "").sort(byCodeUnit);
    for (const name of ticked(cells[1] ?? "")) rows.set(name, specifiers);
  }
  return rows;
}

/**
 * Both derivations, evaluated ONCE.
 *
 * `expectedIndex()` JSON-parses a 30 KB artifact and builds two ~700-entry Maps;
 * `rowsUnder` slices a 150 KB document. Nothing between the calls can change
 * either answer, and they stood at three and four call sites.
 */
const { authoring: expectedAuthoring, internal: expectedInternal } = expectedIndex();
const sectionRows = new Map(PUBLIC_SECTIONS.map((heading) => [heading, rowsUnder(heading)]));
const authoringRows = new Map([...sectionRows.values()].flatMap((rows) => [...rows]));
const internalRows = rowsUnder("Framework internals");
const sorted = (specifiers: string[] | undefined) => [...(specifiers ?? [])].sort(byCodeUnit);

describe("API-INDEX.md", () => {
  test("both artifacts are readable", () => {
    // A broken glob would make every assertion below vacuously pass — the exact
    // failure this file exists to catch one level up.
    expect(index, `API-INDEX.md is missing. ${remedy}`).not.toBe("");
    expect(exportsJson, "API-EXPORTS.json is missing.").not.toBe("");
    expect(expectedAuthoring.size).toBeGreaterThan(600);
    expect(expectedInternal.size).toBeGreaterThan(100);
  });

  test("the public sections are API-EXPORTS.json inverted", () => {
    expect(
      [...authoringRows.keys()].sort(byCodeUnit),
      `the index lists ${authoringRows.size} public name(s), the surface has ` +
        `${expectedAuthoring.size}. ${remedy}`,
    ).toEqual([...expectedAuthoring.keys()].sort(byCodeUnit));
    for (const [name, specifiers] of expectedAuthoring) {
      expect(authoringRows.get(name), `${name} is indexed against the wrong subpath(s)`).toEqual(
        sorted(specifiers),
      );
    }
  });

  test("each public name is listed in exactly one section", () => {
    // The sections are audiences; a name under two would make the reader pick
    // an audience to find an import, which is the question the file answers.
    const total = [...sectionRows.values()].reduce((sum, rows) => sum + rows.size, 0);
    expect(total, remedy).toBe(authoringRows.size);
  });

  test("the internal half holds what the public half does not", () => {
    expect([...internalRows.keys()].sort(byCodeUnit), remedy).toEqual(
      [...expectedInternal.keys()].sort(byCodeUnit),
    );
    for (const [name, specifiers] of expectedInternal) {
      expect(internalRows.get(name), `${name} is indexed against the wrong subpath(s)`).toEqual(
        sorted(specifiers),
      );
    }
    // A name in both halves would tell a reader they have a choice of import
    // where one of the two is explicitly not covered by semver.
    for (const name of internalRows.keys()) expect(authoringRows.has(name)).toBe(false);
  });

  test("it answers the question it exists for", () => {
    // The worked case from the audit that added this file: three of the names a
    // workflow author must write were reachable only from the subpath
    // documented as the surface for a caller OUTSIDE the agent.
    expect(authoringRows.get("WorkflowInputOf")).toContain("@alexkroman1/aai");
    expect(authoringRows.get("WorkflowRunOf")).toContain("@alexkroman1/aai");
    expect(authoringRows.get("agent")).toEqual(["@alexkroman1/aai"]);
  });

  test("names land in the section of the reader they are for", () => {
    expect(sectionRows.get("Agent authoring")?.has("agent")).toBe(true);
    expect(sectionRows.get("Browser client")?.has("useSession")).toBe(true);
    expect(sectionRows.get("Testing and evals")?.has("stubGenerate")).toBe(true);
    expect(sectionRows.get("Hosting and tooling")?.has("createRuntime")).toBe(true);
  });
});
