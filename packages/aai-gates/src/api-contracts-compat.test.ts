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

import { beforeAll, describe, expect, test } from "vitest";
import { sole } from "./_gate-support.ts";

type Probe = { compatible: boolean; problems: string[]; unproven: string[]; added: string[] };
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
    unproven: [],
    added: [],
  };

/** `BASE` with one edit. A `from` it no longer contains would test nothing, so it throws. */
const edit = (from: string, to: string) => {
  if (!BASE.includes(from)) throw new Error(`the fixture no longer contains ${from}`);
  return BASE.replace(from, to);
};

// The first probe in a process loads the TypeScript 6 checker and parses its lib
// and `@types/node` (~1.4s here, past 5s on a loaded CI runner with coverage);
// every later one reuses both (~40ms). That is a one-time FIXTURE cost, so it is
// paid here rather than charged to whichever test happens to run first.
beforeAll(() => {
  probe(BASE);
});

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
    // Mutually assignable, so it passed until removed members were walked for:
    // an object literal naming `retries` is an excess-property error.
    ["a removed OPTIONAL member", edit("    retries?: number;\n", ""), "ToolOptions"],
    [
      "a member dropped from a parameter's type (new-to-old accepts it)",
      edit("tool(options: ToolOptions)", 'tool(options: Omit<ToolOptions, "name">)'),
      "tool",
    ],
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

describe("an UNCHANGED declaration is one declaration, even where it is only reached", () => {
  // Two separately declared copies of a generic conditional are unrelated to
  // the checker, so before unchanged declarations were shared, the options
  // type below failed the probe of `slot` as soon as `slot` itself moved.
  const SLOT = `type Guard<R> = [R] extends [PromiseLike<unknown>] ? "sync only" : unknown;

// @public
export interface SlotOptions<T, After = void> {
    after?: ((draft: T) => After) & Guard<After>;
}

// @public
export function slot<T, After = void>(create: () => T, options?: SlotOptions<T, After>): T;
`;

  test("a changed signature reaching an unchanged conditional still probes compatible", () => {
    const next = SLOT.replace(
      "options?: SlotOptions<T, After>)",
      "options?: SlotOptions<T, After>, key?: string)",
    );
    const result = probe(next, SLOT);
    expect(result.problems).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  test("the reached declaration CHANGING is still a break", () => {
    const next = SLOT.replace('? "sync only" : unknown', '? "sync only" : never');
    expect(probe(next, SLOT).compatible).toBe(false);
  });
});

/**
 * Members TypeScript relates BIVARIANTLY — method shorthand, and a class's
 * constructor — so a narrowed parameter there passed both directions of the
 * old probe. Each rejection sits beside the widening it must still accept.
 */
const METHODS = `// @public
export interface Channel {
    send(message: string | number): void;
    close?(reason: string | number): void;
    on(event: "open", listener: () => void): this;
    on(event: "data", listener: (chunk: string | number) => void): this;
    map<T extends string | number>(fn: (value: T) => T): T[];
    label?: string;
}

type Literal<S extends string> = string extends S ? never : S;

// @public
export type Clock = {
    sleep<const Label extends string>(label: Label & Literal<Label>, ms: number): Promise<void>;
    note?: string;
};

// @public
export declare const transport: {
    post(message: string | number): void;
    end?(reason: string | number): void;
};

// @public
export declare class Sink {
    constructor(target: string | number);
    write(chunk: string | number): void;
    static open(path: string | number): Sink;
}
`;

const methods = (from: string, to: string) => {
  if (!METHODS.includes(from)) throw new Error(`the fixture no longer contains ${from}`);
  return METHODS.replace(from, to);
};

describe("methods and constructors are compared STRICTLY, not bivariantly", () => {
  test("an unchanged method-bearing rollup is still compatible", () => {
    // Add an optional member to each type so none short-circuits on identity:
    // every method is really compared.
    const next = methods("    label?: string;", "    label?: string;\n    tag?: string;")
      .replace("    note?: string;", "    note?: string;\n    zone?: string;")
      .replace("    write(chunk", "    flush?(): void;\n    write(chunk");
    const result = probe(next, METHODS);
    expect(result.problems).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  // Widening is accepted where only a VALUE is compared (new assignable to
  // old). `Channel` and `Sink`'s instance type are compared both ways —
  // they are received as well as built — so a widened member there fails the
  // other direction, as it did before methods were compared strictly.
  test.each([
    [
      "a widened method parameter",
      methods("post(message: string | number)", "post(message: unknown)"),
    ],
    [
      "a widened optional-method parameter",
      methods("end?(reason: string | number)", "end?(reason: unknown)"),
    ],
    [
      "a widened static method parameter",
      methods("open(path: string | number)", "open(path: unknown)"),
    ],
    [
      "a widened constructor parameter",
      methods("constructor(target: string | number)", "constructor(target: unknown)"),
    ],
  ])("accepted: %s", (_label, next) => {
    const result = probe(next, METHODS);
    expect(result.problems).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  test.each([
    [
      "a narrowed method parameter",
      methods("send(message: string | number)", "send(message: string)"),
      "Channel",
    ],
    [
      "a narrowed method parameter on a value",
      methods("post(message: string | number)", "post(message: string)"),
      "transport",
    ],
    [
      "a narrowed optional-method parameter",
      methods("close?(reason: string | number)", "close?(reason: string)"),
      "Channel",
    ],
    [
      "a narrowed parameter in ONE overload",
      methods("(chunk: string | number) => void): this", "(chunk: string) => void): this"),
      "Channel",
    ],
    [
      "a narrowed generic method constraint",
      methods("map<T extends string | number>", "map<T extends string>"),
      "Channel",
    ],
    [
      "a narrowed class method parameter",
      methods("write(chunk: string | number)", "write(chunk: string)"),
      "Sink",
    ],
    [
      "a narrowed static method parameter",
      methods("open(path: string | number)", "open(path: string)"),
      "Sink",
    ],
    [
      "a narrowed constructor parameter",
      methods("constructor(target: string | number)", "constructor(target: string)"),
      "Sink",
    ],
  ])("rejected: %s", (_label, next, name) => {
    const result = probe(next, METHODS);
    expect(result.compatible).toBe(false);
    expect(
      result.problems.some((problem) => problem.startsWith(`${name}:`)),
      `expected a finding naming ${name}, got:\n${result.problems.join("\n")}`,
    ).toBe(true);
  });
});

describe("`any` proves nothing, so a one-sided one is reported", () => {
  test("a member loosened to `any` is UNPROVEN, not compatible", () => {
    const result = probe(edit("    value: string;", "    value: any;"));
    expect(result.compatible).toBe(false);
    expect(result.unproven.some((p) => p.startsWith("ToolResult:") && p.includes("value"))).toBe(
      true,
    );
    // Nothing FAILED: every problem is an unproven position.
    expect(result.problems.every((p) => result.unproven.includes(p))).toBe(true);
  });

  test("a parameter tightened FROM `any` is reported, naming the side", () => {
    const old = edit("tool(options: ToolOptions)", "tool(options: any)");
    const result = probe(BASE, old);
    expect(result.compatible).toBe(false);
    expect(result.unproven.join("\n")).toMatch(/^tool: .*parameter 1 \(options\).*OLD side only/m);
  });

  test("an `any` on BOTH sides is unchanged, and not reported", () => {
    const old = edit("    value: string;", "    value: any;");
    const result = probe(
      old.replace("    ok: boolean;", "    ok: boolean;\n    note?: string;"),
      old,
    );
    expect(result.problems).toEqual([]);
    expect(result.compatible).toBe(true);
  });
});
