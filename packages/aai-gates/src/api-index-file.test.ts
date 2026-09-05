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
 * index is exactly that JSON turned inside out. It lives in aai-templates for
 * the reason `api-surface-file.test.ts` does: raw imports reach the repo root,
 * and this package's tsconfig pulls in no node types.
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

/** The `| \`name\` | \`a\`, \`b\` |` rows under one `##` heading. */
function rowsUnder(heading: string): Map<string, string[]> {
  const start = index.indexOf(`\n## ${heading}\n`);
  if (start < 0) return new Map();
  const rest = index.slice(start + 1);
  const nextHeading = rest.indexOf("\n## ");
  const body = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  const rows = new Map<string, string[]>();
  for (const match of body.matchAll(/^\| `([^`]+)` \| (.+) \|$/gm)) {
    const name = match[1] ?? "";
    const specifiers = (match[2] ?? "").split(", ").map((cell) => cell.replaceAll("`", ""));
    rows.set(name, specifiers);
  }
  return rows;
}

describe("API-INDEX.md", () => {
  test("both artifacts are readable", () => {
    // A broken glob would make every assertion below vacuously pass — the exact
    // failure this file exists to catch one level up.
    expect(index, `API-INDEX.md is missing. ${remedy}`).not.toBe("");
    expect(exportsJson, "API-EXPORTS.json is missing.").not.toBe("");
    const { authoring, internal } = expectedIndex();
    expect(authoring.size).toBeGreaterThan(600);
    expect(internal.size).toBeGreaterThan(100);
  });

  test("the authoring half is API-EXPORTS.json inverted", () => {
    const { authoring } = expectedIndex();
    const rows = rowsUnder("Authoring surface");
    expect(
      [...rows.keys()],
      `the index lists ${rows.size} authoring name(s), the surface has ` +
        `${authoring.size}. ${remedy}`,
    ).toEqual([...authoring.keys()].sort(byCodeUnit));
    for (const [name, specifiers] of authoring) {
      expect(rows.get(name), `${name} is indexed against the wrong subpath(s)`).toEqual(specifiers);
    }
  });

  test("the internal half holds what the authoring half does not", () => {
    const { internal } = expectedIndex();
    const rows = rowsUnder("Framework internals");
    expect([...rows.keys()], remedy).toEqual([...internal.keys()].sort(byCodeUnit));
    const authoringRows = rowsUnder("Authoring surface");
    // A name in both halves would tell a reader they have a choice of import
    // where one of the two is explicitly not covered by semver.
    for (const name of rows.keys()) expect(authoringRows.has(name)).toBe(false);
  });

  test("it answers the question it exists for", () => {
    // The worked case from the audit that added this file: three of the names a
    // workflow author must write were reachable only from the subpath
    // documented as the surface for a caller OUTSIDE the agent.
    const rows = rowsUnder("Authoring surface");
    expect(rows.get("WorkflowInputOf")).toContain("@alexkroman1/aai");
    expect(rows.get("WorkflowRunOf")).toContain("@alexkroman1/aai");
    expect(rows.get("agent")).toEqual(["@alexkroman1/aai"]);
  });
});
