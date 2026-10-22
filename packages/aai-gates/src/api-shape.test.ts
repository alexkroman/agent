// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `check:api-shape`'s guards catch the churn-prone shape, and spare its
 * neighbour.
 *
 * `scripts/_api-shape.mjs` is pure (report text and capability name sets in,
 * findings out), so it is imported as a real value, the way the hash and probe
 * specs beside this one import theirs. Every guard is written as a PAIR: the
 * shape it must flag beside the nearest shape it must not, because a guard
 * that flags nothing prints the same checkmark as a surface that is clean.
 */

import { describe, expect, test } from "vitest";
import { sole } from "./_gate-support.ts";

type Findings = Record<
  | "direction"
  | "positions"
  | "derived"
  | "closedLiterals"
  | "nonAuthoringImports"
  | "thirdPartyTypes"
  | "orphans"
  | "unexportedShared",
  string[]
> & { budgets: Record<string, { exports: number; lines: number }> };
type Shape = {
  indexSurface: (reports: { slug: string; body: string }[]) => unknown;
  shapeFindings: (
    surface: unknown,
    capabilities: Map<string, Set<string>>,
    policy: { nonAuthoring: (m: string) => boolean; isWorkspace: (m: string) => boolean },
  ) => Findings;
};
const shape: Partial<Shape> =
  sole(import.meta.glob<Shape>("../../../scripts/_api-shape.mjs", { eager: true })) ?? {};

const POLICY = {
  nonAuthoring: (module: string) => module.endsWith("/internal"),
  isWorkspace: (module: string) => module.startsWith("@alexkroman1/"),
};

/** Findings for one report body whose capabilities are given as `{ cap: [names] }`. */
function findings(body: string, capabilities: Record<string, string[]>): Findings {
  const surface = shape.indexSurface?.([{ slug: "index", body }]);
  const caps = new Map(Object.entries(capabilities).map(([k, v]) => [k, new Set(v)]));
  const result = shape.shapeFindings?.(surface, caps, POLICY);
  if (result === undefined) throw new Error("scripts/_api-shape.mjs is not importable");
  return result;
}

describe("G1 — direction", () => {
  const body = (tag: string) => `// @public${tag}
export type Options = {
    name: string;
};

// @public
export function make(options: Options): void;
`;

  test("an untagged exported object type is flagged", () => {
    expect(findings(body(""), { tool: ["Options", "make"] }).direction).toEqual(["tool: Options"]);
  });

  test("an `@input` (or `@sealed`) one is not", () => {
    expect(findings(body(" @input"), { tool: ["Options", "make"] }).direction).toEqual([]);
    expect(findings(body(" @sealed"), { tool: ["Options", "make"] }).direction).toEqual([]);
  });

  test("a type reached as input AND output is flagged; one reached one way is not", () => {
    const both = `${body(" @input")}\n// @public\nexport function read(): Options;\n`;
    expect(findings(both, { tool: ["Options", "make", "read"] }).positions).toEqual([
      "tool: Options — reached as input AND output",
    ]);
    expect(findings(body(" @input"), { tool: ["Options", "make"] }).positions).toEqual([]);
  });

  test("an `@input` type reached only as output contradicts its tag", () => {
    const out =
      "// @public @input\nexport type R = {\n    a: string;\n};\n\n// @public\nexport function get(): R;\n";
    expect(findings(out, { tool: ["R", "get"] }).positions).toEqual([
      "tool: R — @input, but reached as output",
    ]);
  });

  test("an alias cut from another object type with Omit is flagged; a fresh type is not", () => {
    const derived = `// @public @sealed
export type Event = {
    name: string;
    at: number;
};

// @public @input
export type Sample = Omit<Event, "at">;
`;
    expect(findings(derived, { metrics: ["Event", "Sample"] }).derived).toEqual([
      "metrics: Sample = Omit<Event>",
    ]);
    const fresh = derived.replace('Omit<Event, "at">', "{\n    name: string;\n}");
    expect(findings(fresh, { metrics: ["Event", "Sample"] }).derived).toEqual([]);
  });
});

describe("G2 — closed literal sets an author receives", () => {
  test("a literal-tuple const is flagged; a const typed as its element is not", () => {
    const tuple = '// @public\nexport const VOICES: readonly ["a", "b"];\n';
    expect(findings(tuple, { tts: ["VOICES"] }).closedLiterals).toEqual([
      "tts: VOICES — literal tuple const",
    ]);
    const open = "// @public\nexport const VOICES: readonly string[];\n";
    expect(findings(open, { tts: ["VOICES"] }).closedLiterals).toEqual([]);
  });

  test("a Record over literal keys is flagged; one over `string` is not", () => {
    const closed = '// @public\nexport const LIMITS: Record<"a" | "b", number>;\n';
    expect(findings(closed, { utils: ["LIMITS"] }).closedLiterals).toEqual([
      "utils: LIMITS — Record over literal keys",
    ]);
    const open = "// @public\nexport const LIMITS: Record<string, number>;\n";
    expect(findings(open, { utils: ["LIMITS"] }).closedLiterals).toEqual([]);
  });

  test("a closed union in a RETURN is flagged; the same union as a parameter is not", () => {
    const out = '// @public\nexport function mode(): "fast" | "slow";\n';
    expect(findings(out, { s: ["mode"] }).closedLiterals).toEqual([
      "s: mode — closed literal union in output position",
    ]);
    const inp = '// @public\nexport function mode(m: "fast" | "slow"): void;\n';
    expect(findings(inp, { s: ["mode"] }).closedLiterals).toEqual([]);
  });

  test("a CALLBACK parameter is output position; `(string & {})` opens the union", () => {
    const callback = `// @public @input
export type Opts = {
    onPhase: (phase: "idle" | "busy") => void;
};

// @public
export function watch(options: Opts): void;
`;
    expect(findings(callback, { s: ["Opts", "watch"] }).closedLiterals).toEqual([
      "s: Opts.onPhase — closed literal union in output position",
    ]);
    const opened = callback.replace('"idle" | "busy"', '"idle" | "busy" | (string & {})');
    expect(findings(opened, { s: ["Opts", "watch"] }).closedLiterals).toEqual([]);
  });
});

describe("G3/G4 — what a signature may import", () => {
  const using = (module: string) =>
    `import { Thing } from '${module}';\n\n// @public\nexport function f(t: Thing): void;\n`;

  test("a name from a non-authoring subpath is flagged; from an authoring one it is not", () => {
    expect(findings(using("@alexkroman1/aai/internal"), { c: ["f"] }).nonAuthoringImports).toEqual([
      "c: Thing from @alexkroman1/aai/internal",
    ]);
    expect(findings(using("@alexkroman1/aai"), { c: ["f"] }).nonAuthoringImports).toEqual([]);
  });

  test("a third-party type is flagged unless its module is allowed", () => {
    expect(findings(using("xstate"), { c: ["f"] }).thirdPartyTypes).toEqual([
      "c: Thing from xstate",
    ]);
    expect(findings(using("@standard-schema/spec"), { c: ["f"] }).thirdPartyTypes).toEqual([]);
  });
});

describe("G4 — orphans and budgets", () => {
  test("a contracted type no contracted signature reaches is an orphan; a reached one is not", () => {
    const body = `// @public @input
export type Used = {
    a: string;
};

// @public @input
export type Lonely = {
    b: string;
};

// @public
export function f(u: Used): void;
`;
    expect(findings(body, { c: ["Used", "Lonely", "f"] }).orphans).toEqual(["c: Lonely"]);
  });

  test("a capability over its export budget is reported with its size; one under is not", () => {
    const names = Array.from({ length: 41 }, (_, i) => `f${i}`);
    const body = names.map((n) => `// @public\nexport function ${n}(): void;\n`).join("\n");
    expect(findings(body, { big: names }).budgets.big?.exports).toBe(41);
    expect(findings(body, { small: names.slice(0, 40) }).budgets).toEqual({});
  });
});

describe("G5 — an unexported declaration hashed into several capabilities", () => {
  const body = `type Hidden = {
    x: string;
};

// @public
export function a(h: Hidden): void;

// @public
export function b(h: Hidden): void;
`;

  test("reached by two capabilities, it is flagged", () => {
    expect(findings(body, { one: ["a"], two: ["b"] }).unexportedShared).toEqual(["Hidden"]);
  });

  test("reached by one, it is not", () => {
    expect(findings(body, { one: ["a", "b"] }).unexportedShared).toEqual([]);
  });
});
