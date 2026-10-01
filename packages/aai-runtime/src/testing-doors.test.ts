// Copyright 2026 the AAI authors. MIT license.
/**
 * The two testing doors are SUPERSETS, as the same declarations.
 *
 * `/testing` promises every name of `@alexkroman1/aai/testing`; `/testing/vitest`
 * every name of `@alexkroman1/aai/testing/vitest` and of `/eval/vitest`. Each
 * door is a hand-kept named list (no `export *`), so a helper the SDK or the
 * eval door gains next would silently be missing from the door an author was
 * told to use. Values are compared by identity — a re-export is the same
 * object — and type names by the barrels' own export lists, which is the only
 * place a type-only name exists at run time.
 */

import { readFileSync } from "node:fs";
import * as sdkTesting from "@alexkroman1/aai/testing";
import * as sdkTestingVitest from "@alexkroman1/aai/testing/vitest";
import { describe, expect, test } from "vitest";
import * as evalVitest from "./eval-vitest-barrel.ts";
import * as testing from "./testing-barrel.ts";
import * as testingVitest from "./testing-vitest-barrel.ts";

/** Every name a barrel's `export { … }` clauses list, types included. */
function exportedNames(url: URL): Set<string> {
  const source = readFileSync(url, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const names = new Set<string>();
  for (const clause of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of (clause[1] ?? "").split(",")) {
      const name = part.trim().replace(/^type\s+/, "");
      if (name) names.add(name);
    }
  }
  return names;
}

const SDK_SRC = new URL("../../aai/src/sdk/", import.meta.url);
const barrel = (name: string, base: URL = new URL("./", import.meta.url)) =>
  exportedNames(new URL(name, base));

const missing = (from: Set<string>, door: Set<string>) =>
  [...from].filter((name) => !door.has(name)).sort((a, b) => a.localeCompare(b));

describe("/testing is a superset of @alexkroman1/aai/testing", () => {
  test("every SDK value is the same object", () => {
    for (const [name, value] of Object.entries(sdkTesting)) {
      expect((testing as Record<string, unknown>)[name], name).toBe(value);
    }
  });

  test("every SDK name, types included, is listed", () => {
    const sdk = barrel("testing-barrel.ts", SDK_SRC);
    expect(sdk.size).toBeGreaterThan(50);
    expect(missing(sdk, barrel("testing-barrel.ts"))).toEqual([]);
  });
});

describe("/testing/vitest is a superset of the SDK's installers and /eval/vitest", () => {
  test("every value is the same object", () => {
    for (const source of [sdkTestingVitest, evalVitest]) {
      for (const [name, value] of Object.entries(source)) {
        expect((testingVitest as Record<string, unknown>)[name], name).toBe(value);
      }
    }
  });

  test("every name, types included, is listed", () => {
    const door = barrel("testing-vitest-barrel.ts");
    const installers = barrel("testing-vitest-barrel.ts", SDK_SRC);
    const evalDoor = barrel("eval-vitest-barrel.ts");
    expect(installers.size).toBeGreaterThan(5);
    expect(evalDoor.size).toBeGreaterThan(50);
    expect(missing(installers, door)).toEqual([]);
    expect(missing(evalDoor, door)).toEqual([]);
  });
});
