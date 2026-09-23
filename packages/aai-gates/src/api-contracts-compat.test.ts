// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The compatibility probe accepts what cannot break a consumer, and REJECTS
 * what can.
 *
 * `scripts/_api-contracts-compat.mjs` is what lets a moved capability hash
 * become a REVISION of its epoch instead of a `--bump` (G1). Every change it
 * accepts lands with no human classification at all, so an over-eager probe is
 * a breaking change shipped under a checkmark — which is why this suite is
 * written in the same PAIRS as the hash spec beside it: each accepted change
 * next to the neighbouring break it must still catch.
 *
 * The probe compiles a real TypeScript program over two in-memory rollups, so
 * these are behavioural tests of the rule, not of its source text. It reads
 * lib declarations from disk and writes nothing.
 */

import { describe, expect, test } from "vitest";
import { sole } from "./_gate-support.ts";

type Probe = { compatible: boolean; problems: string[]; added: string[] };
const { probeCompatibility } =
  sole(
    import.meta.glob<{
      probeCompatibility: (input: { oldBody: string; newBody: string; dir: string }) => Probe;
    }>("../../../scripts/_api-contracts-compat.mjs", { eager: true }),
  ) ?? {};

/**
 * A capability rollup in the shape API Extractor writes one: release-tag
 * comments, bodiless `export function`, a bare `const`, an unexported helper.
 */
const BASE = `// @public
export interface ToolOptions {
    name: string;
    retries?: number;
}

// @public
export function tool(options: ToolOptions): ToolResult;

// @public
export type ToolResult = {
    ok: boolean;
    value: string;
};

// @public
export type Mode = "fast" | "slow";

// @public
export const LIMIT: 30;

interface Hidden<T extends string = string> {
    x: T;
}

// @public
export type Wrap<T extends string> = Hidden<T>;

// @public
export type OutputOf<D> = D extends { run: () => infer R } ? R : never;
`;

// A directory with no imports to resolve; the bodies above import nothing.
const DIR = "/nonexistent-probe-root";

const probe = (newBody: string, oldBody = BASE): Probe =>
  probeCompatibility?.({ oldBody, newBody, dir: DIR }) ?? {
    compatible: false,
    problems: ["probeCompatibility-not-importable"],
    added: [],
  };

/** `BASE` with one edit. A `from` it no longer contains would test nothing, so it throws. */
const edit = (from: string, to: string) => {
  if (!BASE.includes(from)) throw new Error(`the fixture no longer contains ${from}`);
  return BASE.replace(from, to);
};

describe("the probe is importable, and not vacuous", () => {
  test("an identical rollup is compatible", () => {
    // Including the generic conditional `OutputOf`, which two separately
    // declared copies can never prove assignable — the closure-identity path
    // is what keeps an UNCHANGED one from reading as a break forever.
    const result = probe(BASE);
    expect(result.problems).toEqual([]);
    expect(result.compatible).toBe(true);
  });
});

describe("accepted — additive or otherwise invisible to a consumer", () => {
  test.each([
    ["an optional member", edit("retries?: number;", "retries?: number;\n    label?: string;")],
    [
      "an optional parameter",
      edit("tool(options: ToolOptions)", "tool(options: ToolOptions, x?: number)"),
    ],
    ["a new export", `${BASE}\n// @public\nexport declare function extra(): void;\n`],
    ["a const's value (its kind is unchanged)", edit("LIMIT: 30", "LIMIT: 45")],
    ["a renamed parameter", edit("tool(options: ToolOptions)", "tool(opts: ToolOptions)")],
    [
      "a doc or release-tag change",
      edit("// @public\nexport type Mode", "// @public (undocumented)\nexport type Mode"),
    ],
  ])("%s", (_label, next) => {
    const result = probe(next);
    expect(result.problems).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  test("an added export is reported, so the revision's reason can name it", () => {
    expect(probe(`${BASE}\n// @public\nexport declare function extra(): void;\n`).added).toEqual([
      "extra",
    ]);
  });
});

describe("rejected — a real break still needs `--bump`", () => {
  test.each([
    ["a removed export", edit('// @public\nexport type Mode = "fast" | "slow";', ""), "Mode"],
    [
      "a REQUIRED member added to an input type",
      edit("retries?: number;", "retries?: number;\n    label: string;"),
      "ToolOptions",
    ],
    [
      "a return that provides less (a member dropped)",
      edit("    ok: boolean;\n    value: string;", "    ok: boolean;"),
      "ToolResult",
    ],
    [
      "a widened return",
      edit(
        "tool(options: ToolOptions): ToolResult;",
        "tool(options: ToolOptions): ToolResult | undefined;",
      ),
      "tool",
    ],
    [
      "an added required parameter",
      edit("tool(options: ToolOptions)", "tool(options: ToolOptions, x: number)"),
      "tool",
    ],
    [
      "a narrowed parameter",
      edit("tool(options: ToolOptions)", "tool(options: ToolOptions & { strict: true })"),
      "tool",
    ],
    [
      "a widened union a consumer switches over",
      edit('"fast" | "slow"', '"fast" | "slow" | "turbo"'),
      "Mode",
    ],
    ["a narrowed union an author passes", edit('"fast" | "slow"', '"fast"'), "Mode"],
    ["a const whose KIND changed", edit("LIMIT: 30", 'LIMIT: "30"'), "LIMIT"],
    [
      "a changed unexported helper reached through an export",
      edit("    x: T;\n}", "    x: T;\n    y: T;\n}"),
      "Wrap",
    ],
    ["a changed generic conditional", edit("? R : never", "? Promise<R> : never"), "OutputOf"],
  ])("%s", (_label, next, name) => {
    const result = probe(next);
    expect(result.compatible).toBe(false);
    expect(
      result.problems.some((problem) => problem.startsWith(`${name}:`)),
      `expected a finding naming ${name}, got:\n${result.problems.join("\n")}`,
    ).toBe(true);
  });

  test("a re-export whose SOURCE moved is a break, even with the same name", () => {
    const from = (module: string) => `import { Thing } from '${module}';\n\nexport { Thing }\n`;
    const result = probe(from("b"), from("a"));
    expect(result.compatible).toBe(false);
    expect(result.problems.join("\n")).toContain("Thing");
  });
});
