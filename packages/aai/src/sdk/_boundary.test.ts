// Copyright 2026 the AAI authors. MIT license.
/**
 * The bundle/runtime boundary: the registry's shape, the helpers, and the GATE
 * that keeps every cross-copy key in one file (see `_boundary.ts`).
 *
 * The scan reads this package's source. `aai-runtime`'s half — no hand-spelled
 * SDK key there — is `sdk-boundary.test.ts` in that package, so a runtime edit
 * re-runs it.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { BOUNDARY_KEYS, globalSlot, readBrand, setBrand } from "./_boundary.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THIS_MODULE = path.join(SRC, "sdk", "_boundary.ts");

const ALL_KEYS: string[] = [
  ...Object.values(BOUNDARY_KEYS.brands),
  ...Object.values(BOUNDARY_KEYS.slots),
];

/** Every non-test TypeScript source under `src/`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test(-d)?\.tsx?$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .filter((file) => !file.includes(`${path.sep}contracts${path.sep}`));
}

afterEach(() => globalSlot<number>("stepEnv").set(undefined));

describe("BOUNDARY_KEYS", () => {
  test("every key is distinct and owned by a package prefix", () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
    for (const key of ALL_KEYS) expect(key).toMatch(/^@alexkroman1\/aai(-runtime)?\.[a-zA-Z.]+$/);
  });
});

describe("globalSlot", () => {
  test("two handles on one name share the value, as two bundle copies must", () => {
    globalSlot<number>("stepEnv").set(7);
    expect(globalSlot<number>("stepEnv").get()).toBe(7);
    expect(Reflect.get(globalThis, Symbol.for(BOUNDARY_KEYS.slots.stepEnv))).toBe(7);
  });

  test("set(undefined) deletes the property rather than storing undefined", () => {
    const slot = globalSlot<number>("stepEnv");
    slot.set(1);
    slot.set(undefined);
    expect(slot.get()).toBeUndefined();
    expect(Object.getOwnPropertySymbols(globalThis)).not.toContain(
      Symbol.for(BOUNDARY_KEYS.slots.stepEnv),
    );
  });
});

describe("brands", () => {
  test("a brand set by one copy is read by another (the registry symbol is shared)", () => {
    const value = {};
    // What a second copy of this module does: the same registered string.
    Object.defineProperty(value, Symbol.for(BOUNDARY_KEYS.brands.routeError), { value: true });
    expect(readBrand(value, "routeError")).toBe(true);
  });

  test("non-enumerable by default, so neither a spread nor JSON carries it", () => {
    const value = { a: 1 };
    setBrand(value, "routeResponse", true);
    expect(readBrand(value, "routeResponse")).toBe(true);
    expect(readBrand({ ...value }, "routeResponse")).toBeUndefined();
    expect(JSON.stringify(value)).toBe('{"a":1}');
  });

  test("an enumerable brand survives a spread", () => {
    const value = {};
    setBrand(value, "clientTool", { timeoutMs: 5 }, { enumerable: true });
    expect(readBrand({ ...value }, "clientTool")).toEqual({ timeoutMs: 5 });
  });

  test("reads a function, and answers undefined for a primitive", () => {
    const fn = () => undefined;
    setBrand(fn, "keylessSynthesizer", true);
    expect(readBrand(fn, "keylessSynthesizer")).toBe(true);
    for (const primitive of [undefined, null, 1, "x", true]) {
      expect(readBrand(primitive, "stepError")).toBeUndefined();
    }
  });
});

describe("the gate: every cross-copy key lives in _boundary.ts", () => {
  const files = sourceFiles(SRC).filter((file) => file !== THIS_MODULE);

  test("the scan sees the SDK (a scan that reads nothing passes everything)", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(path.join(SRC, "sdk", "client-tool.ts"));
  });

  test("no SDK source outside _boundary.ts calls Symbol.for", () => {
    // Comments and strings may NAME it; a call is `Symbol.for(` in code. Doc
    // comments are stripped first so prose explaining the mechanism is free.
    const offenders = files.filter((file) => {
      const code = readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      return code.includes("Symbol.for(");
    });
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  test("no SDK source outside _boundary.ts spells a registered key", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      for (const key of ALL_KEYS) {
        if (text.includes(`"${key}"`)) offenders.push(`${path.relative(SRC, file)}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
