// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `check:defaults` can actually fail, and is actually run.
 *
 * The gate holds every restated default — a field's `@defaultValue`, the docs
 * site's tuning table, the scaffold guide's "(default X)" — to the `DEFAULT_*`
 * constant that IS the default. Its success output is three counts, the shape
 * that keeps printing a checkmark over nothing: a JSDoc scan, a table parser
 * or a guide parser that stopped matching compares empty with empty. The script
 * carries a floor for each; this suite counts each source independently and
 * asserts the floors are real.
 *
 * It also re-checks the simplest subset itself — a numeric `@defaultValue`
 * naming a constant declared as a numeric literal — with a second, text-only
 * implementation, so a gate whose comparison quietly stopped comparing (the
 * failure it was written for: `minBargeInWords` said 2 against a constant of 1)
 * is caught here too.
 */

import { describe, expect, test } from "vitest";
import { GATE_WIRING, numericConstant, sole } from "./_gate-support.ts";

const gateSource: string =
  sole(
    import.meta.glob<string>("../../../scripts/check-defaults.mjs", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";

const docsPage: string =
  sole(
    import.meta.glob<string>("../../../docs/src/content/docs/more/voices-and-models.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";

/** The whole authoring guide: the core and its `agent-guide/` topic files. */
const guide: string = [
  sole(
    import.meta.glob<string>("../../aai-templates/scaffold/CLAUDE.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "",
  ...Object.values(
    import.meta.glob<string>("../../aai-templates/scaffold/agent-guide/*.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
].join("\n");

const sdkSources: Record<string, string> = import.meta.glob<string>(
  [
    "../../aai/src/sdk/**/*.ts",
    "!../../aai/src/sdk/**/*.test.ts",
    "!../../aai/src/sdk/**/*.test-d.ts",
  ],
  { query: "?raw", import: "default", eager: true },
);

const floor = (name: string): number =>
  numericConstant(gateSource, name, "scripts/check-defaults.mjs");

/** Every `@defaultValue` whose text opens with a backticked literal. */
const literalTags = (): string[] =>
  Object.values(sdkSources).flatMap((source) =>
    [...source.matchAll(/@defaultValue\s+`([^`]+)`/g)].map((match) => match[1] ?? ""),
  );

describe("check:defaults", () => {
  test("is wired into both runners", () => {
    for (const [file, source] of Object.entries(GATE_WIRING)) {
      expect(source, `${file} did not resolve`).toBeTypeOf("string");
      expect(source, `${file} does not run check:defaults`).toContain("check:defaults");
    }
  });

  test("its sources resolve", () => {
    expect(gateSource).toContain("@defaultValue");
    expect(docsPage).toContain("## Tuning the conversation");
    expect(guide.length).toBeGreaterThan(10_000);
    expect(Object.keys(sdkSources).length).toBeGreaterThan(50);
  });

  test("carries a floor on each source, under the actual counts and above zero", () => {
    const tags = literalTags();
    expect(floor("MIN_LITERAL_TAGS")).toBeGreaterThan(0);
    expect(tags.length).toBeGreaterThanOrEqual(floor("MIN_LITERAL_TAGS"));

    const named = Object.values(sdkSources).flatMap((source) =>
      [...source.matchAll(/@defaultValue\s+`[^`]+`[^@]*?\(`[A-Z][A-Z0-9_]+`\)/g)].map((m) => m[0]),
    );
    expect(floor("MIN_CONSTANT_TAGS")).toBeGreaterThan(0);
    expect(named.length).toBeGreaterThanOrEqual(floor("MIN_CONSTANT_TAGS"));

    const section = docsPage.split("## Tuning the conversation")[1]?.split(/\n## /)[0] ?? "";
    const rows = [...section.matchAll(/^\| `[\w.]+` .*\| `[^`]+`[^|]*\|\s*$/gm)];
    expect(floor("MIN_TABLE_ROWS")).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThanOrEqual(floor("MIN_TABLE_ROWS"));

    const statements = [...guide.matchAll(/\(default [\w".]/g)];
    expect(floor("MIN_GUIDE_STATEMENTS")).toBeGreaterThan(0);
    expect(statements.length).toBeGreaterThanOrEqual(floor("MIN_GUIDE_STATEMENTS"));
  });

  test("every numeric @defaultValue that names a literal constant states its value", () => {
    // The text-only second implementation, over the subset text can answer.
    const declared = new Map<string, number>();
    for (const source of Object.values(sdkSources)) {
      for (const match of source.matchAll(
        /^export const ([A-Z][A-Z0-9_]+)(?::\s*number)?\s*=\s*([0-9][0-9_]*);/gm,
      )) {
        declared.set(match[1] ?? "", Number((match[2] ?? "").replaceAll("_", "")));
      }
    }
    const pairs = Object.values(sdkSources).flatMap((source) =>
      [...source.matchAll(/@defaultValue\s+`([0-9][0-9_]*)`[^@]*?\(`([A-Z][A-Z0-9_]+)`\)/g)].map(
        (match) => ({
          stated: Number((match[1] ?? "").replaceAll("_", "")),
          constant: match[2] ?? "",
        }),
      ),
    );
    // Measured 2026-10: 10 such pairs. A floor, so a regex that stopped
    // matching cannot pass this test by finding nothing to disagree with.
    expect(pairs.length).toBeGreaterThan(5);
    const wrong = pairs
      .filter((pair) => declared.has(pair.constant))
      .filter((pair) => declared.get(pair.constant) !== pair.stated)
      .map((pair) => `${pair.constant}: stated ${pair.stated}, is ${declared.get(pair.constant)}`);
    expect(wrong).toEqual([]);
  });
});
